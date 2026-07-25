import { meshCodes, meshBounds } from "../public/mesh.js";

const FINDINGS = new Set(["frass", "adult_alive", "adult_dead", "exit_hole", "none"]);
const SPECIES = new Set([
  "sakura", "ume", "momo", "sumomo", "other_rosaceae", "non_rosaceae", "unknown",
]);
const LAND_TYPES = new Set(["public", "private", "unknown"]);
const RESPONSE_STATUS = new Set(["scheduled", "treating", "done"]);
const DECISIONS = new Set(["confirmed", "rejected", "duplicate"]);
const LOC_SOURCES = new Set(["exif", "geolocation", "manual"]);
const MAP_LEVELS = new Set(["mesh3", "mesh4", "mesh5"]);
const RESPONSE_BUCKETS = new Set(["none", "scheduled", "treating", "done"]);
const REACTION_KINDS = new Set(["seen_too", "thanks"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const HOURLY_LIMIT = 30;
const SESSION_HOURS = 12;
const OAUTH_STATE_TTL_SEC = 300;
const AUTH_SESSION_HOURS = 24 * 30;

const bad = (error, status = 400) => Response.json({ ok: false, error }, { status });

// =====================================================================
// 小道具
// =====================================================================
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// atob() は1文字=1バイトのバイナリ文字列を返すだけで UTF-8 の組み直しはしない。
// 日本語のレビュアー名が文字化けするため、必ずこれを経由してデコードする。
function b64urlDecodeUtf8(str) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return dec.decode(bytes);
}

async function sha256Short(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function hmac(text, secret) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// =====================================================================
// レビュアー認証(暫定)
//   本番運用前に Cloudflare Access へ移すこと。
//   共有パスワードのため個人の識別は自己申告に依存している。
// =====================================================================
async function issueSession(name, env) {
  const payload = b64url(enc.encode(JSON.stringify({
    n: name, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600,
  })));
  return `${payload}.${await hmac(payload, env.REVIEW_SECRET)}`;
}

async function readSession(request, env) {
  const raw = readCookie(request, "rv");
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  if (sig !== await hmac(payload, env.REVIEW_SECRET)) return null;
  try {
    const data = JSON.parse(b64urlDecodeUtf8(payload));
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data.n;
  } catch {
    return null;
  }
}

// =====================================================================
// 通報者(市民)ログイン(任意)。ゲスト運用の上に追加するだけで、
// ゲストの機能・データを一切制限しない。レビュアー認証(rv/REVIEW_SECRET)
// とは信頼レベルも対象読者も別なので、Cookie名・秘密鍵ともに共用しない。
// =====================================================================
async function issueUserSession(reporterId, env) {
  const payload = b64url(enc.encode(JSON.stringify({
    r: reporterId, exp: Math.floor(Date.now() / 1000) + AUTH_SESSION_HOURS * 3600,
  })));
  return `${payload}.${await hmac(payload, env.AUTH_SECRET)}`;
}

async function readUserSession(request, env) {
  const raw = readCookie(request, "uid");
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  if (sig !== await hmac(payload, env.AUTH_SECRET)) return null;
  try {
    const data = JSON.parse(b64urlDecodeUtf8(payload));
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    if (!UUID_RE.test(data.r)) return null;
    return data.r;
  } catch {
    return null;
  }
}

// =====================================================================
// 通報の受付
// =====================================================================
async function computePriority(env, { reporterId, finding, locConflict, mesh3 }) {
  let p = 100;
  if (finding === "none") p += 60;
  if (finding === "frass" || finding === "adult_alive") p -= 20;
  if (locConflict) p -= 30;

  const row = await env.DB.prepare(
    `SELECT
       (SELECT trust_score FROM reporters WHERE id = ?1) AS trust,
       (SELECT COUNT(*) FROM reports WHERE mesh3 = ?2 AND status = 'confirmed') AS here`
  ).bind(reporterId, mesh3).first();

  p += Math.round(((row?.trust ?? 0.5) - 0.5) * 60);
  if ((row?.here ?? 0) === 0) p -= 20;
  return Math.max(1, p);
}

async function createReport(request, env) {
  const form = await request.formData();

  const reporterId = String(form.get("reporter_id") || "");
  if (!UUID_RE.test(reporterId)) {
    return bad("通報者IDが不正です");
  }

  const lat = Number(form.get("lat"));
  const lng = Number(form.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return bad("位置情報がありません");
  if (lat < 20 || lat > 46 || lng < 122 || lng > 154) return bad("日本国内の座標ではありません");

  const finding = String(form.get("finding") || "");
  if (!FINDINGS.has(finding)) return bad("発見物の指定が不正です");

  const species = String(form.get("tree_species") || "unknown");
  if (!SPECIES.has(species)) return bad("樹種の指定が不正です");

  const locSource = String(form.get("loc_source") || "");
  if (!LOC_SOURCES.has(locSource)) return bad("位置情報の取得方法が不正です");
  const locConflict = form.get("loc_conflict") === "1" ? 1 : 0;
  const accField = form.get("loc_accuracy_m");
  const accRaw = accField === null ? NaN : Number(accField);
  const accuracy = Number.isFinite(accRaw) ? accRaw : null;
  const obsRaw = Number(form.get("observed_at"));
  const observedAt = Number.isFinite(obsRaw) && obsRaw > 0 ? Math.floor(obsRaw) : null;
  const note = String(form.get("note") || "").trim().slice(0, 500) || null;

  const full = form.get("full");
  const thumb = form.get("thumb");
  if (!(full instanceof File) || !(thumb instanceof File)) return bad("画像がありません");
  if (full.size === 0 || thumb.size === 0) return bad("画像が空です");
  if (full.size > MAX_IMAGE_BYTES) return bad("画像が大きすぎます");
  if (full.type !== "image/jpeg" || thumb.type !== "image/jpeg") return bad("JPEG のみ受け付けます");

  // メッシュコードは必ずサーバ側で再計算する
  const mesh = meshCodes(lat, lng);

  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?1 AND created_at > unixepoch() - 3600"
  ).bind(reporterId).first();
  if ((rate?.n ?? 0) >= HOURLY_LIMIT) {
    return bad("短時間の送信が多すぎます。しばらく待ってから再度お試しください", 429);
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const d = new Date(now * 1000);
  const prefix = `r/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
  const imageKey = `${prefix}/full.jpg`;
  const thumbKey = `${prefix}/thumb.jpg`;

  await env.PHOTOS.put(imageKey, full.stream(), { httpMetadata: { contentType: "image/jpeg" } });
  await env.PHOTOS.put(thumbKey, thumb.stream(), { httpMetadata: { contentType: "image/jpeg" } });

  const priority = await computePriority(env, { reporterId, finding, locConflict, mesh3: mesh.mesh3 });
  const clientHash = await sha256Short(
    `${env.HASH_SALT || "dev"}:${request.headers.get("cf-connecting-ip") || ""}:${
      request.headers.get("user-agent") || ""}`
  );

  const points = finding === "none" ? 2 : 1;
  const kind = finding === "none" ? "negative_survey" : "submit";

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO reporters (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING"
    ).bind(reporterId, now),
    env.DB.prepare(
      `INSERT INTO reports (
         id, reporter_id, created_at, observed_at, lat, lng,
         loc_source, loc_accuracy_m, loc_conflict,
         mesh3, mesh4, mesh5, finding, tree_species, note,
         image_key, thumb_key, image_bytes,
         status, review_priority, turnstile_ok, client_hash
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,
                 'pending_review',?19,0,?20)`
    ).bind(
      id, reporterId, now, observedAt, lat, lng,
      locSource, accuracy, locConflict,
      mesh.mesh3, mesh.mesh4, mesh.mesh5, finding, species, note,
      imageKey, thumbKey, full.size, priority, clientHash
    ),
    env.DB.prepare(
      `INSERT INTO point_events (reporter_id, report_id, kind, points, created_at)
       VALUES (?1,?2,?3,?4,?5)`
    ).bind(reporterId, id, kind, points, now),
    env.DB.prepare(
      `UPDATE reporters SET submitted_count = submitted_count + 1,
                            points_total = points_total + ?2
        WHERE id = ?1`
    ).bind(reporterId, points),
  ]);

  return Response.json({ ok: true, id, mesh3: mesh.mesh3, mesh4: mesh.mesh4, points });
}

// =====================================================================
// レビュー
// =====================================================================
async function reviewQueue(request, env, reviewer) {
  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.created_at, r.observed_at, r.finding, r.tree_species, r.note,
            r.lat, r.lng, r.mesh4, r.mesh5, r.loc_source, r.loc_accuracy_m, r.loc_conflict,
            r.thumb_key, r.image_key, r.review_priority, r.status,
            rp.trust_score, rp.submitted_count, rp.confirmed_count, rp.rejected_count,
            (SELECT COUNT(*) FROM reports x
              WHERE x.mesh5 = r.mesh5 AND x.id <> r.id
                AND x.created_at > r.created_at - 2592000
                AND x.status IN ('pending_review','provisional','confirmed')) AS nearby
       FROM reports r
       JOIN reporters rp ON rp.id = r.reporter_id
      WHERE r.status IN ('pending_review','provisional')
      ORDER BY r.review_priority, r.created_at
      LIMIT ?1`
  ).bind(limit).all();

  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reports WHERE status IN ('pending_review','provisional')"
  ).first();

  if (results.length) {
    await env.DB.prepare(
      `INSERT INTO coord_access_log (reviewer_email, report_id, mesh4, action, created_at)
       VALUES (?1, ?2, ?3, 'view_detail', unixepoch())`
    ).bind(reviewer, results[0].id, results[0].mesh4).run();
  }

  return Response.json({ ok: true, reviewer, pending: pending?.n ?? 0, items: results });
}

async function reviewDecide(request, env, reviewer) {
  const body = await request.json();

  const id = String(body.report_id || "");
  const decision = String(body.decision || "");
  if (!DECISIONS.has(decision)) return bad("判定の指定が不正です");

  const landType = body.land_type ? String(body.land_type) : null;
  if (landType && !LAND_TYPES.has(landType)) return bad("土地種別の指定が不正です");

  const respStatus = body.response_status ? String(body.response_status) : null;
  if (respStatus && !RESPONSE_STATUS.has(respStatus)) return bad("対応状況の指定が不正です");

  const respNote = String(body.response_note || "").trim().slice(0, 300) || null;
  const reviewNote = String(body.review_note || "").trim().slice(0, 300) || null;
  const duplicateOf = body.duplicate_of ? String(body.duplicate_of) : null;

  const row = await env.DB.prepare(
    "SELECT reporter_id, finding, status FROM reports WHERE id = ?1"
  ).bind(id).first();
  if (!row) return bad("該当する通報がありません", 404);
  if (["confirmed", "rejected", "duplicate"].includes(row.status)) {
    return bad("この通報はすでに判定済みです", 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const stmts = [
    env.DB.prepare(
      `UPDATE reports
          SET status = ?2, reviewed_by = ?3, reviewed_at = ?4, review_note = ?5,
              duplicate_of = ?6, land_type = COALESCE(?7, land_type),
              response_status = COALESCE(?8, response_status),
              response_note = COALESCE(?9, response_note),
              response_updated_at = CASE WHEN ?8 IS NOT NULL OR ?9 IS NOT NULL
                                         THEN ?4 ELSE response_updated_at END
        WHERE id = ?1`
    ).bind(id, decision, reviewer, now, reviewNote, duplicateOf, landType, respStatus, respNote),
  ];

  let bonus = 0, confirmedDelta = 0, rejectedDelta = 0;
  if (decision === "confirmed") {
    bonus = row.finding === "none" ? 3 : 10;
    confirmedDelta = 1;
    stmts.push(env.DB.prepare(
      `INSERT INTO point_events (reporter_id, report_id, kind, points, created_at)
       VALUES (?1,?2,'confirm_bonus',?3,?4)`
    ).bind(row.reporter_id, id, bonus, now));
  } else if (decision === "rejected") {
    bonus = -1;
    rejectedDelta = 1;
    stmts.push(env.DB.prepare(
      `INSERT INTO point_events (reporter_id, report_id, kind, points, created_at, note)
       VALUES (?1,?2,'revoke',-1,?3,'誤報のため取り消し')`
    ).bind(row.reporter_id, id, now));
  } else {
    stmts.push(env.DB.prepare(
      `INSERT INTO point_events (reporter_id, report_id, kind, points, created_at, note)
       VALUES (?1,?2,'duplicate_penalty',0,?3,'既存の通報と重複')`
    ).bind(row.reporter_id, id, now));
  }

  // trust_score はラプラス平滑化した確定率。SET の右辺は更新前の値で評価される。
  stmts.push(env.DB.prepare(
    `UPDATE reporters
        SET confirmed_count = confirmed_count + ?2,
            rejected_count  = rejected_count + ?3,
            points_total    = points_total + ?4,
            trust_score     = (confirmed_count + ?2 + 1.0)
                            / (confirmed_count + ?2 + rejected_count + ?3 + 2.0)
      WHERE id = ?1`
  ).bind(row.reporter_id, confirmedDelta, rejectedDelta, bonus));

  await env.DB.batch(stmts);
  return Response.json({ ok: true, id, decision, bonus });
}

// =====================================================================
// 公開マップ
// =====================================================================

// response= クエリ(カンマ区切り、none|scheduled|treating|done のサブセット)を
// バインド値付きの SQL 断片に変換する。none は response_status IS NULL、
// それ以外は IN (...) 。全チェック解除相当(空集合)なら何にもマッチしない "0" を返す。
function buildResponseFilter(param) {
  const buckets = param === null
    ? new Set(RESPONSE_BUCKETS)
    : new Set(String(param).split(",").map((s) => s.trim()).filter(Boolean));
  for (const b of buckets) {
    if (!RESPONSE_BUCKETS.has(b)) throw new Error(`不正な response 値: ${b}`);
  }

  const nonNull = [...buckets].filter((b) => b !== "none");
  const parts = [];
  const binds = [];
  if (nonNull.length) {
    parts.push(`response_status IN (${nonNull.map(() => "?").join(",")})`);
    binds.push(...nonNull);
  }
  if (buckets.has("none")) parts.push("response_status IS NULL");
  return { sql: parts.length ? parts.join(" OR ") : "0", binds };
}

async function publicMap(request, env) {
  const url = new URL(request.url);
  const sp = url.searchParams;

  const level = sp.get("level") || "mesh3";
  if (!MAP_LEVELS.has(level)) return bad("level は mesh3・mesh4・mesh5 のいずれかを指定してください");

  const bboxRaw = sp.get("bbox");
  if (!bboxRaw) return bad("bbox が必要です");
  const parts = bboxRaw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return bad("bbox の形式が不正です");
  let [minLng, minLat, maxLng, maxLat] = parts;
  if (minLng > maxLng || minLat > maxLat) return bad("bbox の範囲が不正です");
  // reports の CHECK 制約と同じ範囲にクランプする
  minLat = Math.max(20, minLat);
  maxLat = Math.min(46, maxLat);
  minLng = Math.max(122, minLng);
  maxLng = Math.min(154, maxLng);

  const fromTs = sp.has("from") ? Number(sp.get("from")) : 0;
  const toTs = sp.has("to") ? Number(sp.get("to")) : 9999999999;
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) return bad("日付範囲が不正です");

  let responseFilter;
  try {
    responseFilter = buildResponseFilter(sp.get("response"));
  } catch (e) {
    return bad(e.message);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // level はバリデーション済みの allow-list からのみ来るので、カラム名として
  // そのまま埋め込んでも安全(bind パラメータは識別子には使えないため)。
  const meshSql = `
    SELECT ${level} AS mesh,
           COUNT(*) FILTER (WHERE finding <> 'none') AS damage_reports,
           COUNT(*) FILTER (WHERE finding <> 'none' AND status = 'confirmed') AS confirmed_reports,
           COUNT(*) FILTER (WHERE finding =  'none') AS clear_surveys,
           MAX(COALESCE(observed_at, created_at)) AS last_report_at
      FROM reports
     WHERE status IN ('provisional','confirmed')
       AND lat BETWEEN ?1 AND ?2 AND lng BETWEEN ?3 AND ?4
       AND COALESCE(observed_at, created_at) BETWEEN ?5 AND ?6
       AND (${responseFilter.sql})
     GROUP BY ${level}
     LIMIT 2000`;

  // 公有地・確定・被害ありの案件のみ正確な座標を返す(異常なし確定はピンにしない)。
  // idx_reports_public_pin の述語と同じ書き方にして部分インデックスを使わせる。
  const pinSql = `
    SELECT r.id, r.lat, r.lng, r.finding, r.tree_species,
           COALESCE(r.observed_at, r.created_at) AS event_at,
           r.response_status, r.response_note,
           (SELECT COUNT(*) FROM reactions x
             WHERE x.report_id = r.id AND x.kind = 'seen_too') AS seen_too_count,
           (SELECT COUNT(*) FROM reactions x
             WHERE x.report_id = r.id AND x.kind = 'thanks')   AS thanks_count
      FROM reports r
     WHERE r.land_type = 'public' AND r.status = 'confirmed' AND r.finding <> 'none'
       AND r.lat BETWEEN ?1 AND ?2 AND r.lng BETWEEN ?3 AND ?4
       AND COALESCE(r.observed_at, r.created_at) BETWEEN ?5 AND ?6
       AND (${responseFilter.sql})
     LIMIT 500`;

  const bind = [minLat, maxLat, minLng, maxLng, fromTs, toTs, ...responseFilter.binds];
  const [meshRows, pinRows] = await Promise.all([
    env.DB.prepare(meshSql).bind(...bind).all(),
    env.DB.prepare(pinSql).bind(...bind).all(),
  ]);

  const features = [];
  for (const row of meshRows.results) {
    const b = meshBounds(row.mesh);
    features.push({
      type: "Feature",
      properties: {
        kind: "mesh", mesh: row.mesh, level,
        damage_reports: row.damage_reports,
        confirmed_reports: row.confirmed_reports,
        clear_surveys: row.clear_surveys,
        last_report_at: row.last_report_at,
      },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [b.lngMin, b.latMin], [b.lngMax, b.latMin],
          [b.lngMax, b.latMax], [b.lngMin, b.latMax],
          [b.lngMin, b.latMin],
        ]],
      },
    });
  }
  for (const row of pinRows.results) {
    features.push({
      type: "Feature",
      properties: {
        kind: "pin", id: row.id, finding: row.finding, tree_species: row.tree_species,
        event_at: row.event_at, response_status: row.response_status,
        response_note: row.response_note,
        seen_too_count: row.seen_too_count, thanks_count: row.thanks_count,
      },
      geometry: { type: "Point", coordinates: [row.lng, row.lat] },
    });
  }

  const body = JSON.stringify({ type: "FeatureCollection", features });
  const response = new Response(body, {
    headers: { "content-type": "application/geo+json", "cache-control": "public, max-age=120" },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

// =====================================================================
// スタンプ(seen_too / thanks)
//   CLAUDE.md ルール6: 2種のみ、複合PKで連打をDBが弾く。ポイントは付与しない。
// =====================================================================

// 近隣の既存通報チェック(重複抑制の一次確認)。認証不要・読み取り専用。
// finding/tree_species/座標/land_type は返さない — 任意の座標に対して問い合わせ
// 可能なので、/api/map のメッシュ集計(件数のみ)より細かい粒度の開示にしないため。
async function nearbyCheck(request, env) {
  const url = new URL(request.url);
  const sp = url.searchParams;

  const reporterId = String(sp.get("reporter_id") || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const lat = Number(sp.get("lat"));
  const lng = Number(sp.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return bad("位置情報がありません");
  if (lat < 20 || lat > 46 || lng < 122 || lng > 154) return bad("日本国内の座標ではありません");

  // メッシュコードは必ずサーバ側で再計算する(クライアント値は信用しない)
  const mesh = meshCodes(lat, lng);

  const row = await env.DB.prepare(
    `SELECT id AS report_id, COALESCE(observed_at, created_at) AS event_at
       FROM reports
      WHERE mesh5 = ?1
        AND reporter_id <> ?2
        AND status IN ('pending_review','provisional','confirmed')
        AND created_at > unixepoch() - 2592000
      ORDER BY created_at DESC
      LIMIT 1`
  ).bind(mesh.mesh5, reporterId).first();

  if (!row) return Response.json({ ok: true, match: false });
  return Response.json({ ok: true, match: true, report_id: row.report_id, event_at: row.event_at });
}

async function createReaction(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("JSON の形式が不正です");
  }

  const reporterId = String(body.reporter_id || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const reportId = String(body.report_id || "");
  if (!reportId) return bad("report_id が必要です");

  const kind = String(body.kind || "");
  if (!REACTION_KINDS.has(kind)) return bad("スタンプの種類が不正です");

  const target = await env.DB.prepare(
    "SELECT reporter_id, status, land_type, finding FROM reports WHERE id = ?1"
  ).bind(reportId).first();
  if (!target) return bad("該当する通報がありません", 404);
  if (target.reporter_id === reporterId) return bad("自分の通報にはスタンプできません");

  if (kind === "seen_too") {
    if (!["pending_review", "provisional", "confirmed"].includes(target.status)) {
      return bad("この通報にはスタンプできません");
    }
  } else {
    // thanks: publicMap() のピン表示条件(land_type/status/finding)と厳密に一致させる
    if (!(target.land_type === "public" && target.status === "confirmed" && target.finding !== "none")) {
      return bad("この通報にはスタンプできません");
    }
  }

  let lat = null, lng = null, mesh5 = null;
  if (body.lat != null && body.lng != null) {
    lat = Number(body.lat);
    lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return bad("位置情報が不正です");
    if (lat < 20 || lat > 46 || lng < 122 || lng > 154) return bad("日本国内の座標ではありません");
    mesh5 = meshCodes(lat, lng).mesh5;
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO reporters (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING"
    ).bind(reporterId, now),
    env.DB.prepare(
      `INSERT INTO reactions (report_id, reporter_id, kind, lat, lng, mesh5, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)
       ON CONFLICT (report_id, reporter_id, kind) DO NOTHING`
    ).bind(reportId, reporterId, kind, lat, lng, mesh5, now),
  ]);

  return Response.json({ ok: true });
}

// =====================================================================
// マイページ(通報者本人の履歴)
//   nearbyCheck/createReaction と同じ信頼モデル: reporter_id を知っている
//   ことのみを根拠に、その reporter_id の履歴を返す。写真は一切含めない
//   (/img/ はレビュアー認証必須のまま。CLAUDE.md ルール1に例外は設けない)。
// =====================================================================
async function mypage(request, env) {
  const url = new URL(request.url);
  const reporterId = String(url.searchParams.get("reporter_id") || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const [summary, reportsRes, eventsRes] = await Promise.all([
    env.DB.prepare(
      `SELECT points_total, submitted_count, confirmed_count, rejected_count
         FROM reporters WHERE id = ?1`
    ).bind(reporterId).first(),
    env.DB.prepare(
      `SELECT id, created_at, observed_at, finding, tree_species, note, status,
              land_type, response_status, response_note
         FROM reports
        WHERE reporter_id = ?1
        ORDER BY created_at DESC
        LIMIT 100`
    ).bind(reporterId).all(),
    env.DB.prepare(
      `SELECT kind, points, created_at, report_id, note
         FROM point_events
        WHERE reporter_id = ?1
        ORDER BY created_at DESC
        LIMIT 200`
    ).bind(reporterId).all(),
  ]);

  return Response.json({
    ok: true,
    summary: summary ?? {
      points_total: 0, submitted_count: 0, confirmed_count: 0, rejected_count: 0,
    },
    reports: reportsRes.results,
    point_events: eventsRes.results,
  });
}

// =====================================================================
// Google ログイン(任意)
//   ゲストの唯一の弱点(端末をまたぐと reporter_id が引き継げない)を
//   解消するためだけの機能。不正対策・レート制限には一切関与しない
//   (それらは常にゲスト同様 reporter_id 単位で今まで通り適用される)。
// =====================================================================
function googleRedirectUri(request) {
  // start と callback で必ず同じ文字列にする(Google はリテラル一致を要求する)。
  // ヘルパーを共用することで自然に一致を保証する。
  return new URL(request.url).origin + "/api/auth/google/callback";
}

async function googleAuthStart(request, env, cookieAttrs) {
  const url = new URL(request.url);
  const reporterId = String(url.searchParams.get("reporter_id") || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");
  if (!env.GOOGLE_CLIENT_ID) return bad("Googleログインは現在利用できません", 503);

  const state = crypto.randomUUID();
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", googleRedirectUri(request));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "online");
  authUrl.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      location: authUrl.toString(),
      // state と、開始時点のローカル reporter_id を1本の Cookie にまとめる
      // (5分の短命 Cookie なのでサーバ側セッションストア不要)。
      // SameSite=Lax が必須: Google からのコールバックはクロスサイト起点の
      // トップレベル遷移なので、Strict だと Cookie が送られず毎回 CSRF
      // チェックに落ちる(rv とはここが違う)。
      "set-cookie": `oauth_state=${state}.${reporterId}; HttpOnly${cookieAttrs}; ` +
        `SameSite=Lax; Path=/api/auth/google; Max-Age=${OAUTH_STATE_TTL_SEC}`,
    },
  });
}

async function googleAuthCallback(request, env, cookieAttrs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code || !stateParam) return bad("Googleログインに失敗しました", 400);

  const raw = readCookie(request, "oauth_state");
  if (!raw) return bad("ログインの有効期限が切れました。もう一度お試しください", 400);
  const [cookieState, linkedReporterId] = raw.split(".");
  if (!cookieState || cookieState !== stateParam || !UUID_RE.test(linkedReporterId || "")) {
    return bad("不正なリクエストです", 400);
  }

  const clearState = `oauth_state=; HttpOnly${cookieAttrs}; SameSite=Lax; ` +
    `Path=/api/auth/google; Max-Age=0`;

  // --- 認可コードをトークンに交換(サーバ間・client_secret 認証済み) ---
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: googleRedirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return bad("Googleとの認証に失敗しました", 502);
  const token = await tokenRes.json();
  if (!token.access_token) return bad("Googleとの認証に失敗しました", 502);

  // --- ユーザー情報取得 ---
  // id_token の署名検証はしない: このトークン交換自体が client_secret で
  // サーバ間認証済みのため、直後に同じ Google へ問い合わせる userinfo の
  // 応答をそのまま信頼して問題ない(クライアントが渡す id_token を
  // 信用するわけではないので、JWT ライブラリは不要)。
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!infoRes.ok) return bad("Googleとの認証に失敗しました", 502);
  const info = await infoRes.json();
  const sub = String(info.sub || "");
  if (!sub) return bad("Googleとの認証に失敗しました", 502);
  const email = info.email ? String(info.email) : null;
  const emailVerified = info.email_verified === true;
  const displayName = info.name ? String(info.name).slice(0, 80) : null;
  const now = Math.floor(Date.now() / 1000);

  const existing = await env.DB.prepare(
    "SELECT id FROM reporters WHERE google_sub = ?1"
  ).bind(sub).first();

  let reporterId;
  try {
    if (existing) {
      // 既にこの Google アカウントに紐づいた行がある = 別端末からの再ログイン。
      // これが「複数端末で同じ reporter_id に戻れる」機能の核心。
      reporterId = existing.id;
      await env.DB.prepare(
        `UPDATE reporters SET display_name = COALESCE(?2, display_name),
                              email = COALESCE(?3, email),
                              email_verified_at = CASE WHEN ?4 THEN ?5 ELSE email_verified_at END
          WHERE id = ?1`
      ).bind(reporterId, displayName, email, emailVerified ? 1 : 0, now).run();
    } else {
      // 初めてこの Google アカウントでログイン。開始時点のローカル reporter_id を
      // そのまま行の ID として使う(既存のゲスト行があればその場でアップグレード。
      // reports/point_events/reactions は reporter_id で紐づいているので
      // ID を変えなければデータ移行は一切不要。行がまだ無ければ新規作成される)。
      reporterId = linkedReporterId;
      await env.DB.prepare(
        `INSERT INTO reporters (id, google_sub, email, email_verified_at, display_name, created_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET
           google_sub = excluded.google_sub,
           email = excluded.email,
           email_verified_at = excluded.email_verified_at,
           display_name = excluded.display_name`
      ).bind(reporterId, sub, email, emailVerified ? now : null, displayName, now).run();
    }
  } catch (e) {
    // email/google_sub の UNIQUE 制約衝突(別の行が同じメールを持っている、
    // または同時ログインの競合)はここに来る。ON CONFLICT(id) は id 以外の
    // 一意制約違反を吸収しないため、明示的に拾って綺麗に失敗させる。
    console.error(e);
    return new Response(null, {
      status: 302,
      headers: { location: "/mypage.html?auth_error=1", "set-cookie": clearState },
    });
  }

  const cookie = await issueUserSession(reporterId, env);
  const headers = new Headers({ location: "/mypage.html" });
  // 1レスポンスで複数 Cookie を扱うには Headers.append を使う
  // (オブジェクトリテラルでは同名キーを2つ持てず、カンマ結合は Set-Cookie の
  // 仕様上安全でない — Expires の値自体にカンマを含むため)。
  headers.append("set-cookie", clearState);
  headers.append("set-cookie",
    `uid=${cookie}; HttpOnly${cookieAttrs}; SameSite=Strict; Path=/; Max-Age=${AUTH_SESSION_HOURS * 3600}`);
  return new Response(null, { status: 302, headers });
}

async function authMe(request, env) {
  const reporterId = await readUserSession(request, env);
  if (!reporterId) return Response.json({ ok: false });

  // google_sub IS NOT NULL も併せて確認: 将来の連携解除機能に備えた防御的チェック
  const row = await env.DB.prepare(
    "SELECT display_name, email FROM reporters WHERE id = ?1 AND google_sub IS NOT NULL"
  ).bind(reporterId).first();
  if (!row) return Response.json({ ok: false });

  return Response.json({
    ok: true, reporter_id: reporterId,
    display_name: row.display_name, email: row.email,
  });
}

// =====================================================================
// ルーティング
// =====================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Secure 属性は HTTPS の時だけ付ける。
    // wrangler dev はローカルで http のため、Safari は Secure Cookie を
    // localhost であっても保存しない(Chrome は例外扱いするが Safari はしない)。
    const cookieAttrs = url.protocol === "https:" ? "; Secure" : "";

    try {
      // --- 通報 ---
      if (path === "/api/reports" && request.method === "POST") {
        return await createReport(request, env);
      }

      // --- 公開マップ(認証不要。メッシュ集計 + 公有地確定案件のみ正確な座標) ---
      if (path === "/api/map" && request.method === "GET") {
        return await publicMap(request, env);
      }

      // --- 近隣の既存通報チェック(重複抑制の一次確認。認証不要・読み取りのみ) ---
      if (path === "/api/nearby" && request.method === "GET") {
        return await nearbyCheck(request, env);
      }

      // --- スタンプ(seen_too / thanks) ---
      if (path === "/api/reactions" && request.method === "POST") {
        return await createReaction(request, env);
      }

      // --- マイページ(reporter_id の一致のみで閲覧可。/img/ は含めない) ---
      if (path === "/api/mypage" && request.method === "GET") {
        return await mypage(request, env);
      }

      // --- Google ログイン(任意。ゲストと並行して使える) ---
      if (path === "/api/auth/google/start" && request.method === "GET") {
        return await googleAuthStart(request, env, cookieAttrs);
      }
      if (path === "/api/auth/google/callback" && request.method === "GET") {
        return await googleAuthCallback(request, env, cookieAttrs);
      }
      if (path === "/api/auth/me" && request.method === "GET") {
        return await authMe(request, env);
      }
      if (path === "/api/auth/logout") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": `uid=; HttpOnly${cookieAttrs}; SameSite=Strict; Path=/; Max-Age=0`,
          },
        });
      }

      // --- レビュアーのログイン ---
      if (path === "/api/review/login" && request.method === "POST") {
        const { password, name } = await request.json();
        if (password !== env.REVIEW_PASSWORD) {
          return bad("パスワードが違います", 401);
        }
        const clean = String(name || "").trim().slice(0, 40);
        if (clean.length < 2) return bad("お名前を入力してください");

        // reports.reviewed_by は reviewers(email) への外部キー。
        // 自己申告の名前をそのまま識別子として使うため、初回ログイン時に登録しておく。
        await env.DB.prepare(
          "INSERT INTO reviewers (email, display_name) VALUES (?1, ?1) ON CONFLICT(email) DO NOTHING"
        ).bind(clean).run();

        const cookie = await issueSession(clean, env);
        return new Response(JSON.stringify({ ok: true, reviewer: clean }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": `rv=${cookie}; HttpOnly${cookieAttrs}; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
          },
        });
      }

      if (path === "/api/review/logout") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": `rv=; HttpOnly${cookieAttrs}; SameSite=Strict; Path=/; Max-Age=0`,
          },
        });
      }

      // --- ここから先はレビュアー限定 ---
      if (path.startsWith("/api/review/") || path.startsWith("/img/")) {
        const reviewer = await readSession(request, env);
        if (!reviewer) return bad("ログインが必要です", 401);

        if (path === "/api/review/queue") return await reviewQueue(request, env, reviewer);
        if (path === "/api/review/decide" && request.method === "POST") {
          return await reviewDecide(request, env, reviewer);
        }

        if (path.startsWith("/img/")) {
          const key = decodeURIComponent(path.slice(5));
          const obj = await env.PHOTOS.get(key);
          if (!obj) return new Response("not found", { status: 404 });
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          headers.set("etag", obj.httpEtag);
          headers.set("cache-control", "private, max-age=3600");
          return new Response(obj.body, { headers });
        }
      }

      if (path === "/api/health") {
        const r = await env.DB.prepare(
          `SELECT COUNT(*) AS total,
                  SUM(status IN ('pending_review','provisional')) AS pending,
                  SUM(status = 'confirmed') AS confirmed
             FROM reports`
        ).first();
        return Response.json({ ok: true, ...r });
      }

      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return bad("サーバ側でエラーが発生しました: " + e.message, 500);
    }
  },
};
