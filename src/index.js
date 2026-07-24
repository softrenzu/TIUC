import { meshCodes } from "../public/mesh.js";

const FINDINGS = new Set(["frass", "adult_alive", "adult_dead", "exit_hole", "none"]);
const SPECIES = new Set([
  "sakura", "ume", "momo", "sumomo", "other_rosaceae", "non_rosaceae", "unknown",
]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const HOURLY_LIMIT = 30;

const bad = (error, status = 400) => Response.json({ ok: false, error }, { status });

async function sha256Short(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// 小さいほど先にレビューする
async function computePriority(env, { reporterId, finding, locConflict, mesh3 }) {
  let p = 100;
  if (finding === "none") p += 60;                       // 異常なし報告は急がない
  if (finding === "frass" || finding === "adult_alive") p -= 20;
  if (locConflict) p -= 30;                              // 位置が怪しいものは早く見る

  const row = await env.DB.prepare(
    `SELECT
       (SELECT trust_score FROM reporters WHERE id = ?1) AS trust,
       (SELECT COUNT(*) FROM reports WHERE mesh3 = ?2 AND status = 'confirmed') AS here`
  ).bind(reporterId, mesh3).first();

  const trust = row?.trust ?? 0.5;
  p += Math.round((trust - 0.5) * 60);                   // 信頼できる人ほど後回しでよい
  if ((row?.here ?? 0) === 0) p -= 20;                   // 新規メッシュは早く見る
  return Math.max(1, p);
}

async function createReport(request, env) {
  const form = await request.formData();

  const reporterId = String(form.get("reporter_id") || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reporterId)) {
    return bad("通報者IDが不正です");
  }

  const lat = Number(form.get("lat"));
  const lng = Number(form.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return bad("位置情報がありません");
  if (lat < 20 || lat > 46 || lng < 122 || lng > 154) {
    return bad("日本国内の座標ではありません");
  }

  const finding = String(form.get("finding") || "");
  if (!FINDINGS.has(finding)) return bad("発見物の指定が不正です");

  const species = String(form.get("tree_species") || "unknown");
  if (!SPECIES.has(species)) return bad("樹種の指定が不正です");

  const locSource = form.get("loc_source") === "exif" ? "exif" : "geolocation";
  const locConflict = form.get("loc_conflict") === "1" ? 1 : 0;
  const accRaw = Number(form.get("loc_accuracy_m"));
  const accuracy = Number.isFinite(accRaw) ? accRaw : null;
  const obsRaw = Number(form.get("observed_at"));
  const observedAt = Number.isFinite(obsRaw) && obsRaw > 0 ? Math.floor(obsRaw) : null;
  const note = String(form.get("note") || "").trim().slice(0, 500) || null;

  const full = form.get("full");
  const thumb = form.get("thumb");
  if (!(full instanceof File) || !(thumb instanceof File)) return bad("画像がありません");
  if (full.size === 0 || thumb.size === 0) return bad("画像が空です");
  if (full.size > MAX_IMAGE_BYTES) return bad("画像が大きすぎます");
  if (full.type !== "image/jpeg" || thumb.type !== "image/jpeg") {
    return bad("JPEG のみ受け付けます");
  }

  // メッシュコードは必ずサーバ側で再計算する。クライアントの申告は使わない。
  const mesh = meshCodes(lat, lng);

  // 簡易レート制限
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

  // 先に R2 へ。D1 が失敗して孤児オブジェクトが残るほうが、
  // 画像のない行が残るより後始末が楽。
  await env.PHOTOS.put(imageKey, full.stream(), {
    httpMetadata: { contentType: "image/jpeg" },
  });
  await env.PHOTOS.put(thumbKey, thumb.stream(), {
    httpMetadata: { contentType: "image/jpeg" },
  });

  const priority = await computePriority(env, {
    reporterId, finding, locConflict, mesh3: mesh.mesh3,
  });
  const clientHash = await sha256Short(
    `${env.HASH_SALT || "dev"}:${request.headers.get("cf-connecting-ip") || ""}:${
      request.headers.get("user-agent") || ""
    }`
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
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6,
         ?7, ?8, ?9,
         ?10, ?11, ?12, ?13, ?14, ?15,
         ?16, ?17, ?18,
         'queued', ?19, 0, ?20
       )`
    ).bind(
      id, reporterId, now, observedAt, lat, lng,
      locSource, accuracy, locConflict,
      mesh.mesh3, mesh.mesh4, mesh.mesh5, finding, species, note,
      imageKey, thumbKey, full.size,
      priority, clientHash
    ),

    env.DB.prepare(
      `INSERT INTO point_events (reporter_id, report_id, kind, points, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(reporterId, id, kind, points, now),

    env.DB.prepare(
      `UPDATE reporters
          SET submitted_count = submitted_count + 1,
              points_total = points_total + ?2
        WHERE id = ?1`
    ).bind(reporterId, points),
  ]);

  return Response.json({ ok: true, id, mesh3: mesh.mesh3, mesh4: mesh.mesh4, points });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- 通報の受付 ---
    if (url.pathname === "/api/reports" && request.method === "POST") {
      try {
        return await createReport(request, env);
      } catch (e) {
        console.error(e);
        return bad("サーバ側でエラーが発生しました: " + e.message, 500);
      }
    }

    // --- 疎通確認 ---
    if (url.pathname === "/api/health") {
      const { results } = await env.DB.prepare(
        "SELECT COUNT(*) AS reports FROM reports"
      ).all();
      return Response.json({ ok: true, reports: results[0].reports });
    }

    // --- 動作確認用の一覧(公開前に認証を Cloudflare Access へ移す) ---
    if (url.pathname === "/api/admin/reports") {
      if (request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
        return bad("forbidden", 403);
      }
      const { results } = await env.DB.prepare(
        `SELECT id, created_at, finding, tree_species, mesh4, lat, lng,
                loc_source, loc_accuracy_m, loc_conflict,
                status, review_priority, thumb_key, note
           FROM reports
          ORDER BY created_at DESC
          LIMIT 50`
      ).all();
      return Response.json({ ok: true, count: results.length, reports: results });
    }

    // --- 画像の配信 ---
    if (url.pathname.startsWith("/img/")) {
      const key = decodeURIComponent(url.pathname.slice(5));
      const obj = await env.PHOTOS.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("cache-control", "private, max-age=3600");
      return new Response(obj.body, { headers });
    }

    return new Response("not found", { status: 404 });
  },
};
