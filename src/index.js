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
// 人がまだ判定していない状態。通報者本人による削除・軽い修正はここまでのみ許可する
// (確定済みの公式記録を後から自己書き換えさせるのはデータの信頼性上不適切なため)。
const UNREVIEWED_STATUSES = new Set(["queued", "auto_rejected", "pending_review", "provisional"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const HOURLY_LIMIT = 30;
const SESSION_HOURS = 12;
const OAUTH_STATE_TTL_SEC = 300;
const AUTH_SESSION_HOURS = 24 * 30;

// AI 一次判定(足切りのみ。種の同定はさせない)。thumb(512px)を渡す設計は
// スキーマの thumb_key コメント「AI判定・一覧用」の通り。
const AI_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const AI_MAX_TOKENS = 100;
const AI_TIMEOUT_MS = 15000;
const TRIAGE_PROMPT = `あなたは市民が投稿した樹木被害通報アプリの写真を一次チェックするアシスタントです。
虫の種類や被害の有無を判定する必要はありません。以下の3点だけを判定してください。
1. trunk_visible: 木の幹(樹皮)がはっきり写っているか
2. debris_like: 木くず状・粉状の排出物や、虫(甲虫)らしきものが写っているか
3. clearly_irrelevant: 樹木や庭・屋外の風景と明らかに無関係な写真か(人物のセルフィー、書類、室内の無関係な物、動物など)

必ず次のJSON形式のみで回答してください。説明文は書かないでください。
{"trunk_visible": true/false, "debris_like": true/false, "clearly_irrelevant": true/false}`;

// キャラ育成ゲーム(仮称「ヨソモン」)。トリアージ投票のXPは point_events/points_total とは
// 完全に別経済(rule3の「投稿の正確性」に紐づく既存ポイントの意味を壊さないため)。
const XP_PER_VOTE = 2;
const XP_PER_REPORT = 5;
const XP_CONFIRM_BONUS = 15; // 「量でなく正しさ」— 投稿時の3倍、レビュアーが被害ありと確定した時のみ
const VOTE_HOURLY_LIMIT = 60;
const VOTE_CHOICES = new Set(["tree", "evidence", "irrelevant"]);
function resolveVoteChoice(choice) {
  if (choice === "tree") return { trunk_visible: 1, debris_like: 0, clearly_irrelevant: 0 };
  if (choice === "evidence") return { trunk_visible: 1, debris_like: 1, clearly_irrelevant: 0 };
  return { trunk_visible: 0, debris_like: 0, clearly_irrelevant: 1 }; // irrelevant
}

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

// AI 一次判定。「幹が写っているか」「木くず状のものがあるか」「明らかに無関係か」の
// 足切りのみ(rule4)。クビアカ固有の判定・種の同定はさせない。
// 失敗・タイムアウト・パース不能は必ず fail-open(pending_review 相当)にする —
// AIの不調で有効な通報を機械的に握り潰すことだけは避ける。
async function classifyReport(env, thumbBuf) {
  if (!env.AI) return { ok: false, raw: "AI binding not configured" };
  try {
    const result = await Promise.race([
      env.AI.run(AI_MODEL, {
        image: [...new Uint8Array(thumbBuf)],
        prompt: TRIAGE_PROMPT,
        max_tokens: AI_MAX_TOKENS,
        temperature: 0,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("AI timeout")), AI_TIMEOUT_MS)),
    ]);
    // 生ログはそのまま保存(neuron使用量なども含めて後で精度比較に使えるため)。
    const raw = JSON.stringify(result ?? null);
    // response は実機確認上オブジェクトで返るが、文字列で返る場合にも両対応しておく。
    let parsed = result?.response;
    if (typeof parsed === "string") {
      const match = parsed.match(/\{[\s\S]*\}/);
      if (!match) return { ok: false, raw };
      parsed = JSON.parse(match[0]);
    }
    if (
      !parsed ||
      typeof parsed.trunk_visible !== "boolean" ||
      typeof parsed.debris_like !== "boolean" ||
      typeof parsed.clearly_irrelevant !== "boolean"
    ) {
      return { ok: false, raw };
    }
    return { ok: true, ...parsed, raw };
  } catch (e) {
    return { ok: false, raw: String(e) };
  }
}

function resolveAiStatus(result) {
  if (!result.ok) return { status: "pending_review", verdict: null, score: null };
  if (result.clearly_irrelevant) return { status: "auto_rejected", verdict: "reject", score: 0 };
  if (result.trunk_visible || result.debris_like) {
    return {
      status: "provisional", verdict: "pass",
      score: result.trunk_visible && result.debris_like ? 1 : 0.7,
    };
  }
  return { status: "pending_review", verdict: "review", score: 0.4 };
}

async function computePriority(env, { reporterId, finding, locConflict, mesh3, aiScore }) {
  let p = 100;
  if (finding === "none") p += 60;
  if (finding === "frass" || finding === "adult_alive") p -= 20;
  if (locConflict) p -= 30;
  if (aiScore === 1) p -= 15; // AIが幹・木くず両方を検出 → 実被害の可能性が高く優先

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

  const now = Math.floor(Date.now() / 1000);

  // レート制限・スパム抑止(同一メッシュへの直近投稿)・定点観測ストリークの現在値を
  // 1往復でまとめて読む(batch実行より前に済ませる。batch内に後置すると今回作成する
  // 行自体を数えてしまいカウントがずれるため)。
  const state = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM reports WHERE reporter_id=?1 AND created_at > ?2 - 3600) AS hourly,
       (SELECT COUNT(*) FROM reports WHERE reporter_id=?1 AND mesh5=?3
          AND created_at > ?2 - 3600) AS mesh_recent,
       (SELECT streak_mesh5 FROM reporters WHERE id=?1) AS streak_mesh5,
       (SELECT streak_count FROM reporters WHERE id=?1) AS streak_count,
       (SELECT streak_at FROM reporters WHERE id=?1) AS streak_at`
  ).bind(reporterId, now, mesh.mesh5).first();
  if ((state?.hourly ?? 0) >= HOURLY_LIMIT) {
    return bad("短時間の送信が多すぎます。しばらく待ってから再度お試しください", 429);
  }

  const id = crypto.randomUUID();
  const d = new Date(now * 1000);
  const prefix = `r/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
  const imageKey = `${prefix}/full.jpg`;
  const thumbKey = `${prefix}/thumb.jpg`;

  const thumbBuf = await thumb.arrayBuffer();
  const [, , aiResult] = await Promise.all([
    env.PHOTOS.put(imageKey, full.stream(), { httpMetadata: { contentType: "image/jpeg" } }),
    env.PHOTOS.put(thumbKey, thumbBuf, { httpMetadata: { contentType: "image/jpeg" } }),
    classifyReport(env, thumbBuf),
  ]);
  const ai = resolveAiStatus(aiResult);

  const priority = await computePriority(env, {
    reporterId, finding, locConflict, mesh3: mesh.mesh3, aiScore: ai.score,
  });
  const clientHash = await sha256Short(
    `${env.HASH_SALT || "dev"}:${request.headers.get("cf-connecting-ip") || ""}:${
      request.headers.get("user-agent") || ""}`
  );

  // auto_rejected(AIが明確に無関係と判定)には投稿時ポイントを一切与えない。
  // 「幹すら写っていない」レベルの投稿は rule3 の「投稿という行為への小さな報酬」の
  // 対象ではない、というシンプルな割り切り。
  const points = ai.status === "auto_rejected" ? 0 : (finding === "none" ? 2 : 1);
  const kind = finding === "none" ? "negative_survey" : "submit";

  // スパム抑止: 直近1時間に自分が同じ250mメッシュへ投稿していれば今回のXPを割り引く
  // (auto_rejectedかどうかは問わずカウントする=本物とゴミを交互に送って抑止を回避
  // させないため)。
  const baseReportXp = (state?.mesh_recent ?? 0) > 0
    ? Math.max(1, Math.floor(XP_PER_REPORT / 2)) : XP_PER_REPORT;

  // 定点観測ストリーク: 同じ地点(mesh5)に20時間〜14日以内で再訪していれば継続、
  // それ以外(新規地点 or 期限切れ)は1にリセット。
  const withinStreakWindow = state?.streak_mesh5 === mesh.mesh5 && state?.streak_at != null &&
    (now - state.streak_at) >= 72000 && (now - state.streak_at) <= 1209600;
  const newStreakCount = withinStreakWindow ? (state?.streak_count ?? 0) + 1 : 1;
  const reportXp = baseReportXp + Math.min(newStreakCount, 5);

  const stmts = [
    env.DB.prepare(
      "INSERT INTO reporters (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING"
    ).bind(reporterId, now),
    env.DB.prepare(
      `INSERT INTO reports (
         id, reporter_id, created_at, observed_at, lat, lng,
         loc_source, loc_accuracy_m, loc_conflict,
         mesh3, mesh4, mesh5, finding, tree_species, note,
         image_key, thumb_key, image_bytes,
         status, review_priority, turnstile_ok, client_hash,
         ai_verdict, ai_score, ai_model, ai_raw, ai_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,
                 ?19,?20,0,?21,?22,?23,?24,?25,?26)`
    ).bind(
      id, reporterId, now, observedAt, lat, lng,
      locSource, accuracy, locConflict,
      mesh.mesh3, mesh.mesh4, mesh.mesh5, finding, species, note,
      imageKey, thumbKey, full.size,
      ai.status, priority, clientHash,
      ai.verdict, ai.score, AI_MODEL, aiResult.raw ?? null, now
    ),
  ];
  if (ai.status !== "auto_rejected") {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO point_events (reporter_id, report_id, kind, points, created_at)
         VALUES (?1,?2,?3,?4,?5)`
      ).bind(reporterId, id, kind, points, now),
      env.DB.prepare(
        `UPDATE reporters SET submitted_count = submitted_count + 1,
                              points_total = points_total + ?2
          WHERE id = ?1`
      ).bind(reporterId, points),
      // キャラ育成ゲームのXP(point_events/points_totalとは別経済。rule3参照)。
      // 通報は一意なイベントで二重送信の衝突を気にする必要がないため、
      // triageVote のような changes() チェーンは不要。xp_total は相対更新のみ行い、
      // レベル(非線形カーブ)は batch 後に JS 側でまとめて計算する。
      // ストリークボーナスは独立の kind を作らず report_submit の amount に合算する
      // (reviewDecide の revoke 時に「この通報で付与した合計XP」を1回のSUMで正確に
      // 取り消せるようにするため)。
      env.DB.prepare(
        `INSERT INTO xp_events (reporter_id, report_id, kind, amount, created_at)
         VALUES (?1,?2,'report_submit',?3,?4)`
      ).bind(reporterId, id, reportXp, now),
      env.DB.prepare(
        `INSERT INTO characters (reporter_id, xp_total, level, created_at, updated_at)
         VALUES (?1,?2,1,?3,?3)
         ON CONFLICT (reporter_id) DO UPDATE SET
           xp_total = characters.xp_total + ?2,
           updated_at = ?3`
      ).bind(reporterId, reportXp, now),
      // 定点観測ストリーク。値は上でJS側で計算済みなので、そのまま絶対値として書き込む。
      env.DB.prepare(
        `UPDATE reporters SET streak_mesh5 = ?2, streak_count = ?3, streak_at = ?4
          WHERE id = ?1`
      ).bind(reporterId, mesh.mesh5, newStreakCount, now),
    );
  }
  await env.DB.batch(stmts);

  let character = null;
  if (ai.status !== "auto_rejected") {
    const char = await env.DB.prepare(
      "SELECT xp_total FROM characters WHERE reporter_id = ?1"
    ).bind(reporterId).first();
    const after = characterProgress(char?.xp_total ?? reportXp);
    const before = characterProgress(after.xp_total - reportXp);
    character = { ...after, xp_gained: reportXp, leveled_up: after.level > before.level };
  }

  return Response.json({
    ok: true, id, mesh3: mesh.mesh3, mesh4: mesh.mesh4, points, status: ai.status, character,
    ai_message: ai.status === "auto_rejected"
      ? "写真から幹や樹木の様子が確認できませんでした。木の幹全体が写るように撮り直して、もう一度お試しください。"
      : null,
  });
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
            r.ai_verdict, r.ai_score,
            rp.trust_score, rp.submitted_count, rp.confirmed_count, rp.rejected_count,
            (SELECT COUNT(*) FROM reports x
              WHERE x.mesh5 = r.mesh5 AND x.id <> r.id
                AND x.created_at > r.created_at - 2592000
                AND x.status IN ('pending_review','provisional','confirmed')) AS nearby,
            (SELECT COUNT(*) FROM triage_votes v WHERE v.report_id = r.id) AS crowd_total,
            (SELECT COUNT(*) FILTER (WHERE trunk_visible = 1 OR debris_like = 1)
               FROM triage_votes v WHERE v.report_id = r.id) AS crowd_pass
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
    `SELECT reporter_id, finding, status,
            (SELECT COALESCE(SUM(amount), 0) FROM xp_events
              WHERE report_id = ?1 AND kind = 'report_submit') AS submit_xp
       FROM reports WHERE id = ?1`
  ).bind(id).first();
  if (!row) return bad("該当する通報がありません", 404);
  // pending_review/provisional以外(確定済み三種に加え、auto_rejectedを直接叩かれるケースも
  // 含めて)は弾く。今回XP処理を新たに足すので、既存の緩いガードを合わせて締める。
  if (!["pending_review", "provisional"].includes(row.status)) {
    return bad("この通報はレビュー待ちではありません", 409);
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
    // キャラ育成ゲームのXP側も「正しさ」に大きく報いる(point_eventsとは別経済)。
    // characters行が無いreporterもいるためON CONFLICT形式で作成もカバーする。
    stmts.push(env.DB.prepare(
      `INSERT INTO xp_events (reporter_id, report_id, kind, amount, created_at)
       VALUES (?1,?2,'confirm_bonus',?3,?4)`
    ).bind(row.reporter_id, id, XP_CONFIRM_BONUS, now));
    stmts.push(env.DB.prepare(
      `INSERT INTO characters (reporter_id, xp_total, level, created_at, updated_at)
       VALUES (?1,?2,1,?3,?3)
       ON CONFLICT (reporter_id) DO UPDATE SET
         xp_total = characters.xp_total + ?2,
         updated_at = ?3`
    ).bind(row.reporter_id, XP_CONFIRM_BONUS, now));
  } else if (decision === "rejected") {
    bonus = -1;
    rejectedDelta = 1;
    stmts.push(env.DB.prepare(
      `INSERT INTO point_events (reporter_id, report_id, kind, points, created_at, note)
       VALUES (?1,?2,'revoke',-1,?3,'誤報のため取り消し')`
    ).bind(row.reporter_id, id, now));
    // 投稿時に付与したXP(通常額・スパム割引・ストリークボーナス込みの実額)を取り消す。
    // 固定値ではなくxp_eventsから実際に付与された合計を引く(point_eventsのrevokeが
    // 固定-1点なのは点数側が元々1〜2点しか無いから成立する簡略化で、XPには使えない)。
    if (row.submit_xp > 0) {
      stmts.push(env.DB.prepare(
        `INSERT INTO xp_events (reporter_id, report_id, kind, amount, created_at)
         VALUES (?1,?2,'revoke',?3,?4)`
      ).bind(row.reporter_id, id, -row.submit_xp, now));
      stmts.push(env.DB.prepare(
        `UPDATE characters SET xp_total = MAX(0, xp_total - ?2) WHERE reporter_id = ?1`
      ).bind(row.reporter_id, row.submit_xp));
    }
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
//   ことのみを根拠に、その reporter_id の履歴を返す。写真(thumb_key/image_key)は
//   本人確認用のキーとしてのみ返す。実際の画像取得は /img/ 側で reporter_id の
//   一致を再検証してから許可する(下記ルーティングのコメント参照)。
// =====================================================================
async function mypage(request, env) {
  const url = new URL(request.url);
  const reporterId = String(url.searchParams.get("reporter_id") || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const [summary, reportsRes, eventsRes] = await Promise.all([
    env.DB.prepare(
      `SELECT points_total, submitted_count, confirmed_count, rejected_count,
              trust_score, streak_count
         FROM reporters WHERE id = ?1`
    ).bind(reporterId).first(),
    env.DB.prepare(
      `SELECT id, created_at, observed_at, finding, tree_species, note, status,
              land_type, response_status, response_note, response_updated_at, thumb_key
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
    summary: {
      points_total: summary?.points_total ?? 0,
      submitted_count: summary?.submitted_count ?? 0,
      confirmed_count: summary?.confirmed_count ?? 0,
      rejected_count: summary?.rejected_count ?? 0,
      trust_score: summary?.trust_score ?? 0.5,
      hunter_rank: hunterRank(summary?.trust_score, summary?.submitted_count),
      streak_count: summary?.streak_count ?? 0,
    },
    reports: reportsRes.results,
    point_events: eventsRes.results,
  });
}

// =====================================================================
// 通報者本人による削除・軽い修正
//   誤報の訂正用。まだ人がレビューしていない通報のみが対象(UNREVIEWED_STATUSES)。
//   mypage と同じ信頼モデル(reporter_id の一致のみが根拠)。
// =====================================================================
async function editOwnReport(request, env) {
  const body = await request.json();
  const id = String(body.report_id || "");
  const reporterId = String(body.reporter_id || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const finding = String(body.finding || "");
  if (!FINDINGS.has(finding)) return bad("発見物の指定が不正です");
  const species = String(body.tree_species || "unknown");
  if (!SPECIES.has(species)) return bad("樹種の指定が不正です");
  const note = String(body.note || "").trim().slice(0, 500) || null;

  const row = await env.DB.prepare(
    "SELECT reporter_id, status FROM reports WHERE id = ?1"
  ).bind(id).first();
  if (!row) return bad("該当する通報がありません", 404);
  if (row.reporter_id !== reporterId) return bad("この通報を編集する権限がありません", 403);
  if (!UNREVIEWED_STATUSES.has(row.status)) {
    return bad("すでにレビュー済みの通報は編集できません", 409);
  }

  // 投稿時点のポイント・review_priority はあえて再計算しない。投稿という行為への
  // 報酬であり、ラベルの訂正で遡って変える必要はないというシンプルな割り切り。
  await env.DB.prepare(
    "UPDATE reports SET finding = ?2, tree_species = ?3, note = ?4 WHERE id = ?1"
  ).bind(id, finding, species, note).run();

  return Response.json({ ok: true });
}

async function deleteOwnReport(request, env) {
  const body = await request.json();
  const id = String(body.report_id || "");
  const reporterId = String(body.reporter_id || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const row = await env.DB.prepare(
    "SELECT reporter_id, status, image_key, thumb_key FROM reports WHERE id = ?1"
  ).bind(id).first();
  if (!row) return bad("該当する通報がありません", 404);
  if (row.reporter_id !== reporterId) return bad("この通報を削除する権限がありません", 403);
  if (!UNREVIEWED_STATUSES.has(row.status)) {
    return bad("すでにレビュー済みの通報は削除できません", 409);
  }

  const pointsRow = await env.DB.prepare(
    "SELECT COALESCE(SUM(points), 0) AS total FROM point_events WHERE report_id = ?1"
  ).bind(id).first();
  const delta = pointsRow?.total ?? 0;

  // rule7(作成時はR2→D1)の逆: 削除はD1を先に消す。R2削除が後で失敗しても
  // 残るのは無害な孤児オブジェクトだけで済む(行だけ残って画像が無い方が壊れる)。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM point_events WHERE report_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM reports WHERE id = ?1").bind(id),
    env.DB.prepare(
      `UPDATE reporters SET submitted_count = MAX(0, submitted_count - 1),
                            points_total = MAX(0, points_total - ?2)
        WHERE id = ?1`
    ).bind(reporterId, delta),
  ]);

  await env.PHOTOS.delete(row.image_key);
  if (row.thumb_key) await env.PHOTOS.delete(row.thumb_key);

  return Response.json({ ok: true });
}

// AIが「明らかに無関係」と判定した通報を、通報者本人の希望で通常のレビュー待ちに戻す。
// AIの足切りはあくまで一次判定(rule4)であり、最終的な可否は常に人間が持つべき
// ——という設計を、実際に誤って弾かれた場合の救済路として具体化したもの。
// ai_verdict/ai_score/ai_raw はAIが実際に何を判定したかの記録として書き換えない
// (review.html側でこの上書きを識別するバッジに使う)。
async function forceReviewReport(request, env) {
  const body = await request.json();
  const id = String(body.report_id || "");
  const reporterId = String(body.reporter_id || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const row = await env.DB.prepare(
    "SELECT reporter_id, status, finding FROM reports WHERE id = ?1"
  ).bind(id).first();
  if (!row) return bad("該当する通報がありません", 404);
  if (row.reporter_id !== reporterId) return bad("この通報を操作する権限がありません", 403);
  if (row.status !== "auto_rejected") {
    return bad("この通報はAI却下の状態ではありません", 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const points = row.finding === "none" ? 2 : 1;
  const kind = row.finding === "none" ? "negative_survey" : "submit";

  await env.DB.batch([
    env.DB.prepare("UPDATE reports SET status = 'pending_review' WHERE id = ?1").bind(id),
    env.DB.prepare(
      `INSERT INTO point_events (reporter_id, report_id, kind, points, created_at)
       VALUES (?1,?2,?3,?4,?5)`
    ).bind(reporterId, id, kind, points, now),
    env.DB.prepare(
      `UPDATE reporters SET submitted_count = submitted_count + 1,
                            points_total = points_total + ?2
        WHERE id = ?1`
    ).bind(reporterId, points),
    // 通常受理された通報と同じくXPも付与する(結果的に同じ pending_review 状態になるため)。
    env.DB.prepare(
      `INSERT INTO xp_events (reporter_id, report_id, kind, amount, created_at)
       VALUES (?1,?2,'report_submit',?3,?4)`
    ).bind(reporterId, id, XP_PER_REPORT, now),
    env.DB.prepare(
      `INSERT INTO characters (reporter_id, xp_total, level, created_at, updated_at)
       VALUES (?1,?2,1,?3,?3)
       ON CONFLICT (reporter_id) DO UPDATE SET
         xp_total = characters.xp_total + ?2,
         updated_at = ?3`
    ).bind(reporterId, XP_PER_REPORT, now),
  ]);

  const char = await env.DB.prepare(
    "SELECT xp_total FROM characters WHERE reporter_id = ?1"
  ).bind(reporterId).first();
  const after = characterProgress(char?.xp_total ?? XP_PER_REPORT);
  const before = characterProgress(after.xp_total - XP_PER_REPORT);
  const character = { ...after, xp_gained: XP_PER_REPORT, leveled_up: after.level > before.level };

  return Response.json({ ok: true, points, character });
}

// =====================================================================
// キャラ育成ゲーム(仮称「ヨソモン」)
//   通報された写真の一次振り分け(トリアージ)を市民参加のミニゲームにする。
//   投票者に見せるのはサムネイルのみで、位置情報・メモ・通報者情報は一切渡さない
//   (rule1は変えない。最終判定権限は今まで通りレビュアーのみ)。
// =====================================================================
// レベルカーブ: 序盤(〜Lv8)は1レベル2〜3XPで速く、Lv8〜10で4〜5XPとやや重くなり、
// 以降も3レベルごとに+1XPずつ緩やかに難度が上がり続ける(天井を作らず長期的な継続動機にする)。
// Lv8=累積19XP(約10コミット)・Lv10=累積27XP(約14コミット)を狙って調整した値。
// characters.level 列は参考値としてのみ書き込み、表示・判定には常にここで xp_total から
// 再計算した値を使う(reporters.points_total のような「集計キャッシュ」の位置づけ)。
function xpCostForLevel(level) {
  return 2 + Math.floor((level - 1) / 3);
}
function xpForLevel(level) {
  let xp = 0;
  for (let l = 1; l < level; l++) xp += xpCostForLevel(l);
  return xp;
}
function xpToLevel(xpTotal) {
  let level = 1;
  while (xpForLevel(level + 1) <= xpTotal) level++;
  return level;
}
function characterProgress(xpTotal) {
  const level = xpToLevel(xpTotal);
  return {
    level, xp_total: xpTotal,
    xp_into_level: xpTotal - xpForLevel(level),
    xp_for_next_level: xpForLevel(level + 1) - xpForLevel(level),
  };
}

// ハンターランク: 既存の trust_score(確定率のラプラス平滑化)をそのまま流用し、
// 新規計算ロジックは持たない。経験(submitted_count)も条件に含めることで、
// 少数サンプルでの偶然の高trust_scoreだけで最上位ランクに届かないようにする。
const HUNTER_RANKS = [
  { rank: "エキスパート", minTrust: 0.85, minSubmitted: 30 },
  { rank: "ベテラン", minTrust: 0.75, minSubmitted: 15 },
  { rank: "一人前", minTrust: 0.6, minSubmitted: 5 },
  { rank: "見習い", minTrust: 0, minSubmitted: 0 },
];
function hunterRank(trustScore, submittedCount) {
  const t = trustScore ?? 0.5, n = submittedCount ?? 0;
  return HUNTER_RANKS.find((r) => t >= r.minTrust && n >= r.minSubmitted)?.rank ?? "見習い";
}

async function getCharacter(request, env) {
  const url = new URL(request.url);
  const reporterId = String(url.searchParams.get("reporter_id") || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const [char, rp] = await Promise.all([
    env.DB.prepare("SELECT xp_total FROM characters WHERE reporter_id = ?1").bind(reporterId).first(),
    env.DB.prepare(
      "SELECT trust_score, submitted_count, streak_count FROM reporters WHERE id = ?1"
    ).bind(reporterId).first(),
  ]);

  return Response.json({
    ok: true, ...characterProgress(char?.xp_total ?? 0),
    trust_score: rp?.trust_score ?? 0.5,
    hunter_rank: hunterRank(rp?.trust_score, rp?.submitted_count),
    streak_count: rp?.streak_count ?? 0,
  });
}

// =====================================================================
// 図鑑(ヨソモン図鑑)
//   reports から直接集計するだけで、新規テーブルは持たない。
//   status='auto_rejected'(AIが明確に無関係と判定)は収集対象から除外する
//   ——除外しないと、ゴミ写真を樹種違いで投げるだけで埋められてしまい
//   rule3の「水増しを構造で防ぐ」に反するため。
// =====================================================================
const ZUKAN_FINDINGS = ["frass", "adult_alive", "adult_dead", "exit_hole"];
const ZUKAN_SPECIES = ["sakura", "ume", "momo", "sumomo", "other_rosaceae"];

async function getEncyclopedia(request, env) {
  const url = new URL(request.url);
  const reporterId = String(url.searchParams.get("reporter_id") || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT finding, tree_species FROM reports
      WHERE reporter_id = ?1 AND status <> 'auto_rejected'
        AND finding IN ('frass','adult_alive','adult_dead','exit_hole')
        AND tree_species IN ('sakura','ume','momo','sumomo','other_rosaceae')`
  ).bind(reporterId).all();

  const filled = new Set(results.map((r) => `${r.finding}:${r.tree_species}`));
  return Response.json({
    ok: true, total: ZUKAN_FINDINGS.length * ZUKAN_SPECIES.length, count: filled.size,
    slots: ZUKAN_FINDINGS.flatMap((f) => ZUKAN_SPECIES.map((s) => ({
      finding: f, tree_species: s, filled: filled.has(`${f}:${s}`),
    }))),
  });
}

// =====================================================================
// クエスト
//   キュレーションされた固定コンテンツなのでDB駆動にせずコード内定義とする。
//   達成状態はクライアントを信用せず毎回サーバ側の実データから再判定する。
//   受け取り済みフラグだけ quest_claims に持ち、二重受給を防ぐ。
// =====================================================================
const QUESTS = [
  {
    id: "first_report", title: "はじめての記録",
    desc: "ヨソモンの証拠を1件記録しよう", reward: 5, seasonal: null,
    check: async (env, reporterId) => {
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM reports WHERE reporter_id=?1 AND status <> 'auto_rejected'"
      ).bind(reporterId).first();
      return (r?.n ?? 0) >= 1;
    },
  },
  {
    id: "three_species", title: "3樹種チャレンジ",
    desc: "異なる3種類の樹種でヨソモンを記録しよう", reward: 10, seasonal: null,
    check: async (env, reporterId) => {
      const r = await env.DB.prepare(
        `SELECT COUNT(DISTINCT tree_species) AS n FROM reports
          WHERE reporter_id=?1 AND status <> 'auto_rejected' AND tree_species <> 'unknown'`
      ).bind(reporterId).first();
      return (r?.n ?? 0) >= 3;
    },
  },
  {
    id: "triage_master", title: "判定マイスター",
    desc: "写真判定(トリアージ)を10回行おう", reward: 10, seasonal: null,
    check: async (env, reporterId) => {
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM triage_votes WHERE voter_id=?1"
      ).bind(reporterId).first();
      return (r?.n ?? 0) >= 10;
    },
  },
  {
    id: "summer_adult_patrol", title: "夏の成虫パトロール",
    desc: "6〜8月に成虫を見つけて記録しよう(クビアカツヤカミキリの発生期)",
    reward: 10, seasonal: { startMonth: 6, endMonth: 8 },
    check: async (env, reporterId) => {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM reports
          WHERE reporter_id=?1 AND status <> 'auto_rejected'
            AND finding IN ('adult_alive','adult_dead')
            AND CAST(strftime('%m', COALESCE(observed_at, created_at), 'unixepoch') AS INTEGER)
                BETWEEN 6 AND 8`
      ).bind(reporterId).first();
      return (r?.n ?? 0) >= 1;
    },
  },
  {
    id: "zukan_complete", title: "図鑑コンプリート",
    desc: "図鑑を20枠すべて埋めよう", reward: 20, seasonal: null,
    check: async (env, reporterId) => {
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT finding, tree_species FROM reports
          WHERE reporter_id=?1 AND status <> 'auto_rejected'
            AND finding IN ('frass','adult_alive','adult_dead','exit_hole')
            AND tree_species IN ('sakura','ume','momo','sumomo','other_rosaceae')`
      ).bind(reporterId).all();
      return new Set(results.map((r) => `${r.finding}:${r.tree_species}`)).size >= 20;
    },
  },
];

function currentMonth() {
  return new Date().getUTCMonth() + 1;
}

async function getQuests(request, env) {
  const url = new URL(request.url);
  const reporterId = String(url.searchParams.get("reporter_id") || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const month = currentMonth();
  const { results: claimedRows } = await env.DB.prepare(
    "SELECT quest_id FROM quest_claims WHERE reporter_id = ?1"
  ).bind(reporterId).all();
  const claimed = new Set(claimedRows.map((r) => r.quest_id));

  const quests = await Promise.all(QUESTS.map(async (q) => ({
    id: q.id, title: q.title, desc: q.desc, reward: q.reward,
    seasonal: !!q.seasonal,
    active: !q.seasonal || (month >= q.seasonal.startMonth && month <= q.seasonal.endMonth),
    achieved: await q.check(env, reporterId),
    claimed: claimed.has(q.id),
  })));

  return Response.json({ ok: true, quests });
}

async function claimQuest(request, env) {
  const body = await request.json();
  const reporterId = String(body.reporter_id || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");
  const quest = QUESTS.find((q) => q.id === String(body.quest_id || ""));
  if (!quest) return bad("クエストの指定が不正です");

  if (quest.seasonal) {
    const month = currentMonth();
    if (month < quest.seasonal.startMonth || month > quest.seasonal.endMonth) {
      return bad("このクエストは現在の期間では受け取れません");
    }
  }
  // クライアントの自己申告を信用せず、サーバ側の実データで再判定する。
  if (!(await quest.check(env, reporterId))) {
    return bad("まだ達成条件を満たしていません", 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO quest_claims (reporter_id, quest_id, claimed_at) VALUES (?1,?2,?3)
       ON CONFLICT (reporter_id, quest_id) DO NOTHING`
    ).bind(reporterId, quest.id, now),
    env.DB.prepare(
      `INSERT INTO xp_events (reporter_id, report_id, kind, amount, created_at)
       SELECT ?1, NULL, 'quest_bonus', ?2, ?3 WHERE changes() = 1`
    ).bind(reporterId, quest.reward, now),
    env.DB.prepare(
      `INSERT INTO characters (reporter_id, xp_total, level, created_at, updated_at)
       SELECT ?1, ?2, 1, ?3, ?3 WHERE changes() = 1
       ON CONFLICT (reporter_id) DO UPDATE SET
         xp_total = characters.xp_total + ?2, updated_at = ?3`
    ).bind(reporterId, quest.reward, now),
  ]);
  const awarded = results[0].meta.changes > 0;

  const char = await env.DB.prepare(
    "SELECT xp_total FROM characters WHERE reporter_id = ?1"
  ).bind(reporterId).first();
  const after = characterProgress(char?.xp_total ?? 0);
  const before = awarded ? characterProgress(after.xp_total - quest.reward) : after;

  return Response.json({
    ok: true, awarded, leveled_up: awarded && after.level > before.level, ...after,
  });
}

// =====================================================================
// 地域インパクト・ローカルランキング
//   自治体境界データが無い(survey_meshは未整備)ため、mesh3(約1km四方)を
//   「地域」の代用単位とする(未調査エリア表示と同じ代用指標パターン)。
//   ランキングは他人の識別情報を一切返さず、自分の順位/総人数のみ返す(rule1に抵触しない)。
// =====================================================================
async function getImpact(request, env) {
  const url = new URL(request.url);
  const reporterId = String(url.searchParams.get("reporter_id") || "");
  if (!UUID_RE.test(reporterId)) return bad("通報者IDが不正です");

  const latest = await env.DB.prepare(
    "SELECT mesh3 FROM reports WHERE reporter_id = ?1 ORDER BY created_at DESC LIMIT 1"
  ).bind(reporterId).first();
  if (!latest) return Response.json({ ok: true, available: false });

  const mesh3 = latest.mesh3;
  const now = new Date();
  const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);

  const [stats, ranked] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(status='confirmed') AS confirmed
         FROM reports WHERE mesh3=?1 AND status <> 'auto_rejected' AND created_at >= ?2`
    ).bind(mesh3, monthStart).first(),
    env.DB.prepare(
      `SELECT reporter_id FROM reports
        WHERE mesh3=?1 AND status <> 'auto_rejected' AND created_at >= ?2
        GROUP BY reporter_id ORDER BY COUNT(*) DESC`
    ).bind(mesh3, monthStart).all(),
  ]);
  const rankIndex = ranked.results.findIndex((r) => r.reporter_id === reporterId);

  return Response.json({
    ok: true, available: true, mesh3,
    month_total: stats?.total ?? 0, month_confirmed: stats?.confirmed ?? 0,
    rank: rankIndex >= 0 ? rankIndex + 1 : null, participants: ranked.results.length,
  });
}

async function triageNext(request, env) {
  const url = new URL(request.url);
  const voterId = String(url.searchParams.get("voter_id") || "");
  if (!UUID_RE.test(voterId)) return bad("投票者IDが不正です");

  const exclude = String(url.searchParams.get("exclude") || "")
    .split(",").map((s) => s.trim()).filter(UUID_RE.test.bind(UUID_RE)).slice(0, 20);
  const excludeSql = exclude.length
    ? `AND r.id NOT IN (${exclude.map((_, i) => `?${i + 2}`).join(",")})` : "";

  const row = await env.DB.prepare(
    `SELECT r.id, r.thumb_key,
            (SELECT COUNT(*) FROM triage_votes v WHERE v.report_id = r.id) AS vote_count
       FROM reports r
      WHERE r.status IN ('pending_review','provisional')
        AND r.reporter_id <> ?1
        AND NOT EXISTS (SELECT 1 FROM triage_votes v2
                         WHERE v2.report_id = r.id AND v2.voter_id = ?1)
        ${excludeSql}
      ORDER BY vote_count ASC, r.created_at ASC
      LIMIT 1`
  ).bind(voterId, ...exclude).first();

  if (!row) return Response.json({ ok: true, report: null });
  return Response.json({
    ok: true,
    report: {
      report_id: row.id,
      thumb_url: `/img/${row.thumb_key}?voter_id=${encodeURIComponent(voterId)}`,
    },
  });
}

async function triageVote(request, env) {
  const body = await request.json();
  const reportId = String(body.report_id || "");
  const voterId = String(body.voter_id || "");
  if (!UUID_RE.test(voterId)) return bad("投票者IDが不正です");
  const choice = String(body.choice || "");
  if (!VOTE_CHOICES.has(choice)) return bad("判定の指定が不正です");

  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM triage_votes WHERE voter_id = ?1 AND created_at > unixepoch() - 3600"
  ).bind(voterId).first();
  if ((rate?.n ?? 0) >= VOTE_HOURLY_LIMIT) {
    return bad("短時間の判定が多すぎます。しばらく待ってから再度お試しください", 429);
  }

  const target = await env.DB.prepare(
    "SELECT reporter_id, status FROM reports WHERE id = ?1"
  ).bind(reportId).first();
  if (!target) return bad("該当する通報がありません", 404);
  if (target.reporter_id === voterId) return bad("自分の通報には投票できません");
  if (!["pending_review", "provisional"].includes(target.status)) {
    return bad("この通報は判定対象ではありません");
  }

  const { trunk_visible, debris_like, clearly_irrelevant } = resolveVoteChoice(choice);
  const now = Math.floor(Date.now() / 1000);

  // 1回の batch() でまとめる: 投票の記録とXP付与が別々のD1呼び出しだと、失敗時に
  // 「投票は記録されたのにXPだけ消える」不整合が起きる(rule7と同じ思想)。
  // changes() で前の文の結果を見て後続を条件付きにすることで、二重投票時は
  // xp_events/characters のどちらにも一切書き込まれない(INSERT...SELECT形式なので
  // ON CONFLICT DO UPDATE 側も含めて丸ごとスキップされる)。
  const results = await env.DB.batch([
    // reactions と同じ流儀: 投票者の reporters 行は createReport 等を一度も経由していない
    // かもしれないので、FK 制約に触れる前に必ず遅延作成しておく。
    env.DB.prepare(
      "INSERT INTO reporters (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING"
    ).bind(voterId, now),
    env.DB.prepare(
      `INSERT INTO triage_votes (report_id, voter_id, trunk_visible, debris_like,
                                  clearly_irrelevant, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT (report_id, voter_id) DO NOTHING`
    ).bind(reportId, voterId, trunk_visible, debris_like, clearly_irrelevant, now),
    env.DB.prepare(
      `INSERT INTO xp_events (reporter_id, report_id, kind, amount, created_at)
       SELECT ?1, ?2, 'triage_vote', ?3, ?4
        WHERE changes() = 1`
    ).bind(voterId, reportId, XP_PER_VOTE, now),
    env.DB.prepare(
      // レベル(非線形カーブ)はSQLでは計算せず、batch後にJS側でまとめて計算する
      // (characters.level は参考値としてのみ書き込む「集計キャッシュ」)。
      `INSERT INTO characters (reporter_id, xp_total, level, created_at, updated_at)
       SELECT ?1, ?2, 1, ?3, ?3
        WHERE changes() = 1
       ON CONFLICT (reporter_id) DO UPDATE SET
         xp_total = characters.xp_total + ?2,
         updated_at = ?3`
    ).bind(voterId, XP_PER_VOTE, now),
  ]);
  const awarded = results[1].meta.changes > 0;

  const char = await env.DB.prepare(
    "SELECT xp_total FROM characters WHERE reporter_id = ?1"
  ).bind(voterId).first();
  const after = characterProgress(char?.xp_total ?? 0);
  const before = awarded ? characterProgress(after.xp_total - XP_PER_VOTE) : after;

  return Response.json({
    ok: true, awarded, leveled_up: awarded && after.level > before.level, ...after,
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

      // --- マイページ(reporter_id の一致のみで閲覧可。写真本体は /img/ 側で再検証) ---
      if (path === "/api/mypage" && request.method === "GET") {
        return await mypage(request, env);
      }

      // --- 通報者本人による削除・軽い修正(未レビューのみ) ---
      if (path === "/api/reports/edit" && request.method === "POST") {
        return await editOwnReport(request, env);
      }
      if (path === "/api/reports/delete" && request.method === "POST") {
        return await deleteOwnReport(request, env);
      }
      // --- AI却下(auto_rejected)を本人の希望で通常レビュー待ちに戻す ---
      if (path === "/api/reports/force_review" && request.method === "POST") {
        return await forceReviewReport(request, env);
      }

      // --- キャラ育成ゲーム(仮称「ヨソモン」) ---
      if (path === "/api/character" && request.method === "GET") {
        return await getCharacter(request, env);
      }
      if (path === "/api/triage/next" && request.method === "GET") {
        return await triageNext(request, env);
      }
      if (path === "/api/triage/vote" && request.method === "POST") {
        return await triageVote(request, env);
      }
      if (path === "/api/encyclopedia" && request.method === "GET") {
        return await getEncyclopedia(request, env);
      }
      if (path === "/api/quests" && request.method === "GET") {
        return await getQuests(request, env);
      }
      if (path === "/api/quests/claim" && request.method === "POST") {
        return await claimQuest(request, env);
      }
      if (path === "/api/impact" && request.method === "GET") {
        return await getImpact(request, env);
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
      if (path.startsWith("/api/review/")) {
        const reviewer = await readSession(request, env);
        if (!reviewer) return bad("ログインが必要です", 401);

        if (path === "/api/review/queue") return await reviewQueue(request, env, reviewer);
        if (path === "/api/review/decide" && request.method === "POST") {
          return await reviewDecide(request, env, reviewer);
        }
      }

      // --- 画像配信: レビュアー、または通報者本人(reporter_id が一致する場合)のみ ---
      //   本人閲覧は mypage と同じ信頼モデル(reporter_id を知っていることが根拠)。
      //   image_key/thumb_key 自体に通報IDが埋め込まれ推測不能なため、両方が一致する
      //   ケースだけを許可しても既存の露出面(reporter_id を知っていれば /api/mypage で
      //   履歴が見える)より広がらない。
      if (path.startsWith("/img/")) {
        const key = decodeURIComponent(path.slice(5));
        let authorized = !!(await readSession(request, env));
        if (!authorized) {
          const reporterId = String(url.searchParams.get("reporter_id") || "");
          if (UUID_RE.test(reporterId)) {
            const row = await env.DB.prepare(
              "SELECT 1 FROM reports WHERE (image_key = ?1 OR thumb_key = ?1) AND reporter_id = ?2"
            ).bind(key, reporterId).first();
            authorized = !!row;
          }
        }
        // トリアージ投票(キャラ育成ゲーム)用の匿名投票者。thumb_key にしかマッチさせない
        // (image_key はここでは絶対に許可しない — フル解像度・私有地写真の新規露出を防ぐ)。
        // 未レビューかつ自分の投稿でなく、まだ投票していない場合のみ許可。
        if (!authorized) {
          const voterId = String(url.searchParams.get("voter_id") || "");
          if (UUID_RE.test(voterId)) {
            const row = await env.DB.prepare(
              `SELECT 1 FROM reports r
                WHERE r.thumb_key = ?1
                  AND r.status IN ('pending_review','provisional')
                  AND r.reporter_id <> ?2
                  AND NOT EXISTS (SELECT 1 FROM triage_votes v
                                   WHERE v.report_id = r.id AND v.voter_id = ?2)`
            ).bind(key, voterId).first();
            authorized = !!row;
          }
        }
        if (!authorized) return bad("アクセスできません", 401);

        const obj = await env.PHOTOS.get(key);
        if (!obj) return new Response("not found", { status: 404 });
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("etag", obj.httpEtag);
        headers.set("cache-control", "private, max-age=3600");
        return new Response(obj.body, { headers });
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
