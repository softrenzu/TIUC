import { meshCodes, meshBounds } from "../public/mesh.js";

// =====================================================================
// TIUC: Today is under construction.
// 街なか外国語表記キュレーションアプリ。ドメイン固有ロジックはここから。
// 認証・R2画像配信・メッシュ計算などの土台はクビアカから[流用]。
// =====================================================================

const LANG_PAIRS = new Set(["ja-en", "ja-zh", "ja-ko"]);
const PLACE_KINDS = new Set(["menu", "sign", "notice", "other"]);
const POST_PLACE_KINDS = new Set([...PLACE_KINDS, "unknown"]);
const LOC_SOURCES = new Set(["exif", "geolocation", "manual"]);
const MAP_LEVELS = new Set(["mesh3", "mesh4", "mesh5"]);
const SUBMODES = new Set(["quality", "judgment", "correction"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const POST_HOURLY_LIMIT = 30;
const JUDGE_HOURLY_LIMIT = 60;
const CORRECT_HOURLY_LIMIT = 30;
const VOTE_HOURLY_LIMIT = 60;
const AUTH_SESSION_HOURS = 24 * 30;
const OAUTH_STATE_TTL_SEC = 300;

// ②違和感チェック・③修正案投票 とも、この人数の判定/票が集まった時点で
// 多数決で自動的にステータスを遷移させる(rule9の適応難易度は後発機能。
// MVPはこの固定しきい値で「割れたら人を増やす」設計だけ先に用意する)。
const JUDGMENT_THRESHOLD = 2;
const VOTE_THRESHOLD = 2;

// ポイント経済(rule10: 投稿は小さく、確定・採用時に大きく)
const POINTS_POST_SUBMIT = 2;
const POINTS_JUDGMENT = 1;
const POINTS_CORRECTION_PROPOSE = 3;
const POINTS_CORRECTION_CONFIRM_BONUS = 15;
const POINTS_VOTE = 1;

const bad = (error, status = 400) => Response.json({ ok: false, error }, { status });

// =====================================================================
// 小道具 [流用]
// =====================================================================
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

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
// ユーザー(市民)ログイン(任意)。ゲスト運用の上に追加するだけ [流用]
// =====================================================================
async function issueUserSession(userId, env) {
  const payload = b64url(enc.encode(JSON.stringify({
    u: userId, exp: Math.floor(Date.now() / 1000) + AUTH_SESSION_HOURS * 3600,
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
    if (!UUID_RE.test(data.u)) return null;
    return data.u;
  } catch {
    return null;
  }
}

// 簡易な非線形レベルカーブ(表示用のみ。実効重みは levels テーブルで別管理) [流用]
function pointsCostForLevel(level) {
  return 4 + Math.floor((level - 1) / 3) * 2;
}
function pointsForLevel(level) {
  let p = 0;
  for (let l = 1; l < level; l++) p += pointsCostForLevel(l);
  return p;
}
function levelFromPoints(pointsTotal) {
  let level = 1;
  while (pointsForLevel(level + 1) <= pointsTotal) level++;
  return level;
}

// =====================================================================
// ①撮影投稿モード
// =====================================================================

async function createPost(request, env) {
  const form = await request.formData();

  const userId = String(form.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");

  const lat = Number(form.get("lat"));
  const lng = Number(form.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return bad("位置情報がありません");
  if (lat < 20 || lat > 46 || lng < 122 || lng > 154) return bad("日本国内の座標ではありません");

  const langPair = String(form.get("lang_pair") || "");
  if (!LANG_PAIRS.has(langPair)) return bad("言語ペアの指定が不正です");

  const placeKind = String(form.get("place_kind") || "unknown");
  if (!POST_PLACE_KINDS.has(placeKind)) return bad("表記種別の指定が不正です");

  const flagged = form.get("flagged") === "1" ? 1 : 0;

  const locSource = String(form.get("loc_source") || "");
  if (!LOC_SOURCES.has(locSource)) return bad("位置情報の取得方法が不正です");
  const locConflict = form.get("loc_conflict") === "1" ? 1 : 0;
  const accField = form.get("loc_accuracy_m");
  const accRaw = accField === null ? NaN : Number(accField);
  const accuracy = Number.isFinite(accRaw) ? accRaw : null;
  const obsRaw = Number(form.get("observed_at"));
  const observedAt = Number.isFinite(obsRaw) && obsRaw > 0 ? Math.floor(obsRaw) : null;
  const situation = String(form.get("situation") || "").trim().slice(0, 500) || null;

  // 可変投稿フロー: 原文写真(src)は必須、訳文写真(tgt)は任意(1枚に両方写っていてもよい)
  const srcFull = form.get("src_full");
  const srcThumb = form.get("src_thumb");
  if (!(srcFull instanceof File) || !(srcThumb instanceof File)) return bad("写真がありません");
  if (srcFull.size === 0 || srcThumb.size === 0) return bad("写真が空です");
  if (srcFull.size > MAX_IMAGE_BYTES) return bad("写真が大きすぎます");
  if (srcFull.type !== "image/jpeg" || srcThumb.type !== "image/jpeg") return bad("JPEG のみ受け付けます");

  const tgtFull = form.get("tgt_full");
  const tgtThumb = form.get("tgt_thumb");
  const hasTgt = tgtFull instanceof File && tgtThumb instanceof File;
  if ((tgtFull instanceof File) !== (tgtThumb instanceof File)) {
    return bad("訳文の写真は full/thumb を両方送ってください");
  }
  if (hasTgt) {
    if (tgtFull.size === 0 || tgtThumb.size === 0) return bad("写真が空です");
    if (tgtFull.size > MAX_IMAGE_BYTES) return bad("写真が大きすぎます");
    if (tgtFull.type !== "image/jpeg" || tgtThumb.type !== "image/jpeg") return bad("JPEG のみ受け付けます");
  }

  // メッシュコードは必ずサーバ側で再計算する(rule2)
  const mesh = meshCodes(lat, lng);
  const now = Math.floor(Date.now() / 1000);

  const hourly = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM posts WHERE submitter_id = ?1 AND created_at > ?2 - 3600"
  ).bind(userId, now).first();
  if ((hourly?.n ?? 0) >= POST_HOURLY_LIMIT) {
    return bad("短時間の投稿が多すぎます。しばらく待ってから再度お試しください", 429);
  }

  const id = crypto.randomUUID();
  const d = new Date(now * 1000);
  const prefix = `p/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
  const srcImageKey = `${prefix}/src-full.jpg`;
  const srcThumbKey = `${prefix}/src-thumb.jpg`;
  const tgtImageKey = hasTgt ? `${prefix}/tgt-full.jpg` : null;
  const tgtThumbKey = hasTgt ? `${prefix}/tgt-thumb.jpg` : null;

  const puts = [
    env.PHOTOS.put(srcImageKey, srcFull.stream(), { httpMetadata: { contentType: "image/jpeg" } }),
    env.PHOTOS.put(srcThumbKey, srcThumb.stream(), { httpMetadata: { contentType: "image/jpeg" } }),
  ];
  if (hasTgt) {
    puts.push(
      env.PHOTOS.put(tgtImageKey, tgtFull.stream(), { httpMetadata: { contentType: "image/jpeg" } }),
      env.PHOTOS.put(tgtThumbKey, tgtThumb.stream(), { httpMetadata: { contentType: "image/jpeg" } }),
    );
  }
  await Promise.all(puts);

  const clientHash = await sha256Short(
    `${env.HASH_SALT || "dev"}:${request.headers.get("cf-connecting-ip") || ""}:${
      request.headers.get("user-agent") || ""}`
  );

  // 優先度: 「変かも」フラグ付きは②の配車を優先する。数字が小さいほど先に見る
  let priority = 100;
  if (flagged) priority -= 20;

  const points = POINTS_POST_SUBMIT;

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING"
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO posts (
         id, submitter_id, created_at, observed_at, lat, lng,
         loc_source, loc_accuracy_m, loc_conflict,
         mesh3, mesh4, mesh5, lang_pair, place_kind, flagged, situation,
         src_image_key, src_thumb_key, tgt_image_key, tgt_thumb_key, image_bytes,
         status, review_priority, turnstile_ok, client_hash
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,
                 ?17,?18,?19,?20,?21,'pending_judgment',?22,0,?23)`
    ).bind(
      id, userId, now, observedAt, lat, lng,
      locSource, accuracy, locConflict,
      mesh.mesh3, mesh.mesh4, mesh.mesh5, langPair, placeKind, flagged, situation,
      srcImageKey, srcThumbKey, tgtImageKey, tgtThumbKey, srcFull.size,
      priority, clientHash
    ),
    env.DB.prepare(
      `INSERT INTO point_events (user_id, post_id, kind, points, created_at)
       VALUES (?1,?2,'post_submit',?3,?4)`
    ).bind(userId, id, points, now),
    env.DB.prepare(
      `UPDATE users SET post_count = post_count + 1, points_total = points_total + ?2
        WHERE id = ?1`
    ).bind(userId, points),
  ]);

  return Response.json({ ok: true, id, mesh3: mesh.mesh3, points });
}

// 近隣の既存投稿チェック(重複抑制の一次確認)。認証不要・読み取りのみ [流用]
async function nearbyCheck(request, env) {
  const sp = new URL(request.url).searchParams;
  const userId = String(sp.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");

  const lat = Number(sp.get("lat"));
  const lng = Number(sp.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return bad("位置情報がありません");
  if (lat < 20 || lat > 46 || lng < 122 || lng > 154) return bad("日本国内の座標ではありません");

  const langPair = String(sp.get("lang_pair") || "");
  if (!LANG_PAIRS.has(langPair)) return bad("言語ペアの指定が不正です");

  const mesh = meshCodes(lat, lng);
  const row = await env.DB.prepare(
    `SELECT id AS post_id, COALESCE(observed_at, created_at) AS event_at
       FROM posts
      WHERE mesh5 = ?1 AND lang_pair = ?2 AND submitter_id <> ?3
        AND created_at > unixepoch() - 2592000
      ORDER BY created_at DESC
      LIMIT 1`
  ).bind(mesh.mesh5, langPair, userId).first();

  if (!row) return Response.json({ ok: true, match: false });
  return Response.json({ ok: true, match: true, post_id: row.post_id, event_at: row.event_at });
}

// 投稿者本人による自己削除。誰も判定していない投稿のみ許可
// (他の人が既に労力をかけたものを一方的に消させないため)
async function deletePost(request, env) {
  const body = await request.json();
  const userId = String(body.user_id || "");
  const postId = String(body.post_id || "");
  if (!UUID_RE.test(userId) || !postId) return bad("パラメータが不正です");

  const row = await env.DB.prepare(
    `SELECT p.submitter_id, p.status, p.src_image_key, p.src_thumb_key,
            p.tgt_image_key, p.tgt_thumb_key,
            (SELECT COUNT(*) FROM judgments WHERE post_id = p.id) AS judge_n
       FROM posts p WHERE p.id = ?1`
  ).bind(postId).first();
  if (!row) return bad("該当する投稿がありません", 404);
  if (row.submitter_id !== userId) return bad("この投稿は削除できません", 403);
  if (row.status !== "pending_judgment" || row.judge_n > 0) {
    return bad("既に判定が始まっているため削除できません");
  }

  await env.DB.prepare("DELETE FROM posts WHERE id = ?1").bind(postId).run();
  await Promise.all([
    env.PHOTOS.delete(row.src_image_key),
    env.PHOTOS.delete(row.src_thumb_key),
    row.tgt_image_key ? env.PHOTOS.delete(row.tgt_image_key) : null,
    row.tgt_thumb_key ? env.PHOTOS.delete(row.tgt_thumb_key) : null,
  ].filter(Boolean));

  return Response.json({ ok: true });
}

// =====================================================================
// ②違和感チェック(ネイティブ専用サブモード)
//   一タップ・キュー・重み。全体のスループットを決める配車弁。
// =====================================================================

async function judgeNext(request, env) {
  const sp = new URL(request.url).searchParams;
  const userId = String(sp.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  const langPair = String(sp.get("lang_pair") || "");
  if (!LANG_PAIRS.has(langPair)) return bad("言語ペアの指定が不正です");

  const exclude = String(sp.get("exclude") || "")
    .split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/.test(s)).slice(0, 20);
  const excludeSql = exclude.length
    ? `AND p.id NOT IN (${exclude.map((_, i) => `?${i + 3}`).join(",")})` : "";

  const row = await env.DB.prepare(
    `SELECT p.id, p.src_thumb_key, p.tgt_thumb_key, p.situation, p.place_kind,
            (SELECT COUNT(*) FROM judgments j WHERE j.post_id = p.id) AS judge_count
       FROM posts p
      WHERE p.status = 'pending_judgment' AND p.lang_pair = ?2 AND p.submitter_id <> ?1
        AND NOT EXISTS (SELECT 1 FROM judgments j2 WHERE j2.post_id = p.id AND j2.judge_id = ?1)
        ${excludeSql}
      ORDER BY judge_count ASC, p.review_priority ASC, p.created_at ASC
      LIMIT 1`
  ).bind(userId, langPair, ...exclude).first();

  if (!row) return Response.json({ ok: true, post: null });
  return Response.json({
    ok: true,
    post: {
      post_id: row.id,
      situation: row.situation,
      place_kind: row.place_kind,
      src_thumb_url: `/img/${row.src_thumb_key}?judge_id=${encodeURIComponent(userId)}`,
      tgt_thumb_url: row.tgt_thumb_key
        ? `/img/${row.tgt_thumb_key}?judge_id=${encodeURIComponent(userId)}` : null,
    },
  });
}

async function judgeSubmit(request, env) {
  const body = await request.json();
  const userId = String(body.user_id || "");
  const postId = String(body.post_id || "");
  const verdict = String(body.verdict || "");
  const category = body.category ? String(body.category).slice(0, 40) : null;
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  if (!["natural", "unnatural"].includes(verdict)) return bad("判定の指定が不正です");

  const now = Math.floor(Date.now() / 1000);
  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM judgments WHERE judge_id = ?1 AND created_at > ?2 - 3600"
  ).bind(userId, now).first();
  if ((rate?.n ?? 0) >= JUDGE_HOURLY_LIMIT) {
    return bad("短時間の判定が多すぎます。しばらく待ってから再度お試しください", 429);
  }

  const target = await env.DB.prepare(
    "SELECT submitter_id, status FROM posts WHERE id = ?1"
  ).bind(postId).first();
  if (!target) return bad("該当する投稿がありません", 404);
  if (target.submitter_id === userId) return bad("自分の投稿には判定できません");
  if (target.status !== "pending_judgment") return bad("この投稿は判定対象ではありません");

  const already = await env.DB.prepare(
    "SELECT 1 FROM judgments WHERE post_id = ?1 AND judge_id = ?2"
  ).bind(postId, userId).first();
  if (already) return bad("既に判定済みです");

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING"
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO judgments (id, post_id, verdict, category, judge_id, weight, created_at)
       VALUES (?1,?2,?3,?4,?5,1.0,?6)`
    ).bind(crypto.randomUUID(), postId, verdict, category, userId, now),
    env.DB.prepare(
      `INSERT INTO point_events (user_id, post_id, kind, points, created_at)
       VALUES (?1,?2,'judgment',?3,?4)`
    ).bind(userId, postId, POINTS_JUDGMENT, now),
    env.DB.prepare(
      `UPDATE users SET judged_count = judged_count + 1, points_total = points_total + ?2
        WHERE id = ?1`
    ).bind(userId, POINTS_JUDGMENT),
  ]);

  const counts = await env.DB.prepare(
    `SELECT SUM(verdict = 'natural') AS natural, SUM(verdict = 'unnatural') AS unnatural
       FROM judgments WHERE post_id = ?1`
  ).bind(postId).first();
  const natural = counts?.natural ?? 0, unnatural = counts?.unnatural ?? 0;

  let transitionedTo = null;
  if (unnatural >= JUDGMENT_THRESHOLD && unnatural > natural) transitionedTo = "needs_fix";
  else if (natural >= JUDGMENT_THRESHOLD && natural > unnatural) transitionedTo = "looks_ok";
  if (transitionedTo) {
    await env.DB.prepare(
      "UPDATE posts SET status = ?2 WHERE id = ?1 AND status = 'pending_judgment'"
    ).bind(postId, transitionedTo).run();
  }

  return Response.json({ ok: true, transitioned_to: transitionedTo, points: POINTS_JUDGMENT });
}

// =====================================================================
// ③正誤・修正・解説(バイリンガル専用サブモード)
// =====================================================================

async function correctNext(request, env) {
  const sp = new URL(request.url).searchParams;
  const userId = String(sp.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  const langPair = String(sp.get("lang_pair") || "");
  if (!LANG_PAIRS.has(langPair)) return bad("言語ペアの指定が不正です");

  const row = await env.DB.prepare(
    `SELECT id, src_image_key, tgt_image_key, situation, place_kind,
            original_text, translated_text
       FROM posts
      WHERE status = 'needs_fix' AND lang_pair = ?2 AND submitter_id <> ?1
        AND NOT EXISTS (SELECT 1 FROM corrections c WHERE c.post_id = posts.id AND c.curator_id = ?1)
      ORDER BY review_priority ASC, created_at ASC
      LIMIT 1`
  ).bind(userId, langPair).first();

  if (!row) return Response.json({ ok: true, post: null });
  return Response.json({
    ok: true,
    post: {
      post_id: row.id,
      situation: row.situation,
      place_kind: row.place_kind,
      original_text: row.original_text,
      translated_text: row.translated_text,
      src_image_url: `/img/${row.src_image_key}?curator_id=${encodeURIComponent(userId)}`,
      tgt_image_url: row.tgt_image_key
        ? `/img/${row.tgt_image_key}?curator_id=${encodeURIComponent(userId)}` : null,
    },
  });
}

async function correctSubmit(request, env) {
  const body = await request.json();
  const userId = String(body.user_id || "");
  const postId = String(body.post_id || "");
  const verdict = String(body.verdict || "fix");
  const fixedText = body.fixed_text ? String(body.fixed_text).slice(0, 500) : null;
  const explanation = body.explanation ? String(body.explanation).slice(0, 500) : null;
  const originalText = body.original_text ? String(body.original_text).slice(0, 500) : null;
  const translatedText = body.translated_text ? String(body.translated_text).slice(0, 500) : null;

  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  if (!["fix", "no_issue"].includes(verdict)) return bad("裁定の指定が不正です");
  if (verdict === "fix" && !fixedText) return bad("修正後の訳文を入力してください");

  const now = Math.floor(Date.now() / 1000);
  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM corrections WHERE curator_id = ?1 AND created_at > ?2 - 3600"
  ).bind(userId, now).first();
  if ((rate?.n ?? 0) >= CORRECT_HOURLY_LIMIT) {
    return bad("短時間の提案が多すぎます。しばらく待ってから再度お試しください", 429);
  }

  const target = await env.DB.prepare(
    "SELECT submitter_id, status FROM posts WHERE id = ?1"
  ).bind(postId).first();
  if (!target) return bad("該当する投稿がありません", 404);
  if (target.submitter_id === userId) return bad("自分の投稿には提案できません");
  if (target.status !== "needs_fix") return bad("この投稿は修正提案の対象ではありません");

  const already = await env.DB.prepare(
    "SELECT 1 FROM corrections WHERE post_id = ?1 AND curator_id = ?2"
  ).bind(postId, userId).first();
  if (already) return bad("既に提案済みです");

  const correctionId = crypto.randomUUID();
  const stmts = [
    env.DB.prepare(
      "INSERT INTO users (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING"
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO corrections (id, post_id, fixed_text, explanation, curator_id, verdict, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`
    ).bind(correctionId, postId, fixedText, explanation, userId, verdict, now),
    env.DB.prepare(
      `INSERT INTO point_events (user_id, post_id, kind, points, created_at)
       VALUES (?1,?2,'correction_propose',?3,?4)`
    ).bind(userId, postId, POINTS_CORRECTION_PROPOSE, now),
    env.DB.prepare(
      `UPDATE users SET corrected_count = corrected_count + 1, points_total = points_total + ?2
        WHERE id = ?1`
    ).bind(userId, POINTS_CORRECTION_PROPOSE),
  ];
  if (originalText || translatedText) {
    stmts.push(env.DB.prepare(
      `UPDATE posts SET original_text = COALESCE(?2, original_text),
                        translated_text = COALESCE(?3, translated_text)
        WHERE id = ?1`
    ).bind(postId, originalText, translatedText));
  }
  await env.DB.batch(stmts);

  return Response.json({ ok: true, correction_id: correctionId, points: POINTS_CORRECTION_PROPOSE });
}

async function correctVoteNext(request, env) {
  const sp = new URL(request.url).searchParams;
  const userId = String(sp.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  const langPair = String(sp.get("lang_pair") || "");
  if (!LANG_PAIRS.has(langPair)) return bad("言語ペアの指定が不正です");

  const row = await env.DB.prepare(
    `SELECT c.id, c.fixed_text, c.explanation, c.verdict, c.curator_id,
            p.id AS post_id, p.original_text, p.translated_text, p.situation,
            p.src_image_key, p.tgt_image_key
       FROM corrections c JOIN posts p ON p.id = c.post_id
      WHERE c.status = 'proposed' AND p.lang_pair = ?2 AND c.curator_id <> ?1
        AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.correction_id = c.id AND v.voter_id = ?1)
      ORDER BY c.created_at ASC
      LIMIT 1`
  ).bind(userId, langPair).first();

  if (!row) return Response.json({ ok: true, correction: null });
  return Response.json({
    ok: true,
    correction: {
      correction_id: row.id,
      post_id: row.post_id,
      verdict: row.verdict,
      fixed_text: row.fixed_text,
      explanation: row.explanation,
      original_text: row.original_text,
      translated_text: row.translated_text,
      situation: row.situation,
      src_image_url: `/img/${row.src_image_key}?curator_id=${encodeURIComponent(userId)}`,
      tgt_image_url: row.tgt_image_key
        ? `/img/${row.tgt_image_key}?curator_id=${encodeURIComponent(userId)}` : null,
    },
  });
}

async function correctVoteSubmit(request, env) {
  const body = await request.json();
  const userId = String(body.user_id || "");
  const correctionId = String(body.correction_id || "");
  const agree = body.agree ? 1 : 0;
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  if (!correctionId) return bad("correction_id が必要です");

  const now = Math.floor(Date.now() / 1000);
  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM votes WHERE voter_id = ?1 AND created_at > ?2 - 3600"
  ).bind(userId, now).first();
  if ((rate?.n ?? 0) >= VOTE_HOURLY_LIMIT) {
    return bad("短時間の投票が多すぎます。しばらく待ってから再度お試しください", 429);
  }

  const correction = await env.DB.prepare(
    `SELECT c.post_id, c.curator_id, c.verdict, c.fixed_text, c.status,
            p.original_text, p.lang_pair
       FROM corrections c JOIN posts p ON p.id = c.post_id
      WHERE c.id = ?1`
  ).bind(correctionId).first();
  if (!correction) return bad("該当する修正案がありません", 404);
  if (correction.curator_id === userId) return bad("自分の提案には投票できません");
  if (correction.status !== "proposed") return bad("この修正案は投票対象ではありません");

  const already = await env.DB.prepare(
    "SELECT 1 FROM votes WHERE correction_id = ?1 AND voter_id = ?2"
  ).bind(correctionId, userId).first();
  if (already) return bad("既に投票済みです");

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING"
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO votes (id, correction_id, voter_id, agree, weight, created_at)
       VALUES (?1,?2,?3,?4,1.0,?5)`
    ).bind(crypto.randomUUID(), correctionId, userId, agree, now),
    env.DB.prepare(
      `INSERT INTO point_events (user_id, post_id, kind, points, created_at)
       VALUES (?1,?2,'vote',?3,?4)`
    ).bind(userId, correction.post_id, POINTS_VOTE, now),
    env.DB.prepare(
      "UPDATE users SET points_total = points_total + ?2 WHERE id = ?1"
    ).bind(userId, POINTS_VOTE),
  ]);

  const tally = await env.DB.prepare(
    "SELECT SUM(agree) AS agree_n, COUNT(*) AS total FROM votes WHERE correction_id = ?1"
  ).bind(correctionId).first();
  const agreeN = tally?.agree_n ?? 0, total = tally?.total ?? 0, disagreeN = total - agreeN;

  let confirmed = false;
  if (agreeN >= VOTE_THRESHOLD && agreeN > disagreeN) {
    const res = await env.DB.prepare(
      "UPDATE corrections SET status = 'confirmed' WHERE id = ?1 AND status = 'proposed'"
    ).bind(correctionId).run();
    if (res.meta.changes > 0) {
      confirmed = true;
      const stmts = [];
      if (correction.verdict === "fix") {
        stmts.push(env.DB.prepare(
          "UPDATE posts SET status = 'confirmed', translated_text = ?2 WHERE id = ?1"
        ).bind(correction.post_id, correction.fixed_text));
        // 確定訳は新たなゴールドに昇格する(rule8: 正解の在庫が運用とともに自己増殖する)
        if (correction.original_text) {
          stmts.push(env.DB.prepare(
            `INSERT INTO gold_items (id, task, correct_answer, lang_pair, submode, difficulty, source)
             VALUES (?1,?2,?3,?4,'correction','medium','promoted')`
          ).bind(crypto.randomUUID(), correction.original_text, correction.fixed_text, correction.lang_pair));
        }
      } else {
        stmts.push(env.DB.prepare(
          "UPDATE posts SET status = 'looks_ok' WHERE id = ?1"
        ).bind(correction.post_id));
      }
      stmts.push(
        env.DB.prepare(
          `INSERT INTO point_events (user_id, post_id, kind, points, created_at)
           VALUES (?1,?2,'correction_confirm_bonus',?3,?4)`
        ).bind(correction.curator_id, correction.post_id, POINTS_CORRECTION_CONFIRM_BONUS, now),
        env.DB.prepare(
          "UPDATE users SET points_total = points_total + ?2 WHERE id = ?1"
        ).bind(correction.curator_id, POINTS_CORRECTION_CONFIRM_BONUS),
      );
      await env.DB.batch(stmts);
    }
  } else if (disagreeN >= VOTE_THRESHOLD && disagreeN > agreeN) {
    await env.DB.prepare(
      "UPDATE corrections SET status = 'rejected' WHERE id = ?1 AND status = 'proposed'"
    ).bind(correctionId).run();
  }

  return Response.json({ ok: true, confirmed, points: POINTS_VOTE });
}

// =====================================================================
// 公開マップ(認証不要)。メッシュ集計に加え、投稿直後から正確な座標付き
// ピンを公開する(2026-08-22、rule1改定。店の採用を待たない)。
// =====================================================================
async function publicMap(request, env) {
  const sp = new URL(request.url).searchParams;

  const level = sp.get("level") || "mesh3";
  if (!MAP_LEVELS.has(level)) return bad("level は mesh3・mesh4・mesh5 のいずれかを指定してください");

  const bboxRaw = sp.get("bbox");
  if (!bboxRaw) return bad("bbox が必要です");
  const parts = bboxRaw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return bad("bbox の形式が不正です");
  let [minLng, minLat, maxLng, maxLat] = parts;
  if (minLng > maxLng || minLat > maxLat) return bad("bbox の範囲が不正です");
  minLat = Math.max(20, minLat);
  maxLat = Math.min(46, maxLat);
  minLng = Math.max(122, minLng);
  maxLng = Math.min(154, maxLng);

  const langPairs = String(sp.get("lang_pair") || "ja-en,ja-zh,ja-ko")
    .split(",").map((s) => s.trim()).filter((s) => LANG_PAIRS.has(s));
  if (!langPairs.length) return bad("lang_pair の指定が不正です");
  const langSql = langPairs.map((_, i) => `?${i + 5}`).join(",");

  const cache = caches.default;
  const url = new URL(request.url);
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const meshSql = `
    SELECT ${level} AS mesh,
           COUNT(*) AS post_count,
           COUNT(*) FILTER (WHERE status = 'needs_fix') AS needs_fix_count,
           COUNT(*) FILTER (WHERE status IN ('confirmed','adopted')) AS confirmed_count,
           MAX(COALESCE(observed_at, created_at)) AS last_post_at
      FROM posts
     WHERE lat BETWEEN ?1 AND ?2 AND lng BETWEEN ?3 AND ?4
       AND lang_pair IN (${langSql})
     GROUP BY ${level}
     LIMIT 2000`;

  // rule1改定(2026-08-22): 投稿直後から公開マップに正確なピンを出す。
  // 写真品質NGで機械的に除外された投稿(auto_rejected)のみ除く。
  const pinSql = `
    SELECT id, lat, lng, lang_pair, place_kind, status, original_text, translated_text,
           COALESCE(observed_at, created_at) AS event_at
      FROM posts
     WHERE status <> 'auto_rejected'
       AND lat BETWEEN ?1 AND ?2 AND lng BETWEEN ?3 AND ?4
       AND lang_pair IN (${langSql})
     LIMIT 500`;

  const bind = [minLat, maxLat, minLng, maxLng, ...langPairs];
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
        post_count: row.post_count,
        needs_fix_count: row.needs_fix_count,
        confirmed_count: row.confirmed_count,
        last_post_at: row.last_post_at,
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
        kind: "pin", id: row.id, lang_pair: row.lang_pair, place_kind: row.place_kind,
        status: row.status,
        original_text: row.original_text, translated_text: row.translated_text,
        event_at: row.event_at,
      },
      geometry: { type: "Point", coordinates: [row.lng, row.lat] },
    });
  }

  const body = JSON.stringify({ type: "FeatureCollection", features });
  const response = new Response(body, {
    headers: { "content-type": "application/geo+json", "cache-control": "public, max-age=20" },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

// =====================================================================
// マイページ(本人の履歴)。user_id を知っていることのみを根拠に閲覧可 [流用]
// =====================================================================
async function mypage(request, env) {
  const sp = new URL(request.url).searchParams;
  const userId = String(sp.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");

  const [summary, postsRes, eventsRes, levelsRes] = await Promise.all([
    env.DB.prepare(
      `SELECT points_total, post_count, judged_count, corrected_count, adopted_count, streak_count
         FROM users WHERE id = ?1`
    ).bind(userId).first(),
    env.DB.prepare(
      `SELECT id, created_at, lang_pair, place_kind, situation, status, src_thumb_key,
              original_text, translated_text
         FROM posts
        WHERE submitter_id = ?1
        ORDER BY created_at DESC
        LIMIT 100`
    ).bind(userId).all(),
    env.DB.prepare(
      `SELECT kind, points, created_at, post_id, note
         FROM point_events
        WHERE user_id = ?1
        ORDER BY created_at DESC
        LIMIT 200`
    ).bind(userId).all(),
    env.DB.prepare(
      `SELECT lang_pair, submode, display_rank, declared_level
         FROM levels WHERE user_id = ?1`
    ).bind(userId).all(),
  ]);

  const pointsTotal = summary?.points_total ?? 0;
  return Response.json({
    ok: true,
    summary: {
      points_total: pointsTotal,
      level: levelFromPoints(pointsTotal),
      post_count: summary?.post_count ?? 0,
      judged_count: summary?.judged_count ?? 0,
      corrected_count: summary?.corrected_count ?? 0,
      adopted_count: summary?.adopted_count ?? 0,
      streak_count: summary?.streak_count ?? 0,
    },
    posts: postsRes.results,
    point_events: eventsRes.results,
    levels: levelsRes.results,
  });
}

// =====================================================================
// Google ログイン(任意。ゲストと並行して使える) [流用]
// =====================================================================
function googleRedirectUri(request) {
  return new URL(request.url).origin + "/api/auth/google/callback";
}

async function googleAuthStart(request, env, cookieAttrs) {
  const url = new URL(request.url);
  const userId = String(url.searchParams.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
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
      "set-cookie": `oauth_state=${state}.${userId}; HttpOnly${cookieAttrs}; ` +
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
  const [cookieState, linkedUserId] = raw.split(".");
  if (!cookieState || cookieState !== stateParam || !UUID_RE.test(linkedUserId || "")) {
    return bad("不正なリクエストです", 400);
  }

  const clearState = `oauth_state=; HttpOnly${cookieAttrs}; SameSite=Lax; ` +
    `Path=/api/auth/google; Max-Age=0`;

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
    "SELECT id FROM users WHERE google_sub = ?1"
  ).bind(sub).first();

  let userId;
  try {
    if (existing) {
      userId = existing.id;
      await env.DB.prepare(
        `UPDATE users SET display_name = COALESCE(?2, display_name),
                          email = COALESCE(?3, email),
                          email_verified_at = CASE WHEN ?4 THEN ?5 ELSE email_verified_at END
          WHERE id = ?1`
      ).bind(userId, displayName, email, emailVerified ? 1 : 0, now).run();
    } else {
      userId = linkedUserId;
      await env.DB.prepare(
        `INSERT INTO users (id, google_sub, email, email_verified_at, display_name, created_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET
           google_sub = excluded.google_sub,
           email = excluded.email,
           email_verified_at = excluded.email_verified_at,
           display_name = excluded.display_name`
      ).bind(userId, sub, email, emailVerified ? now : null, displayName, now).run();
    }
  } catch (e) {
    console.error(e);
    return new Response(null, {
      status: 302,
      headers: { location: "/mypage.html?auth_error=1", "set-cookie": clearState },
    });
  }

  const cookie = await issueUserSession(userId, env);
  const headers = new Headers({ location: "/mypage.html" });
  headers.append("set-cookie", clearState);
  headers.append("set-cookie",
    `uid=${cookie}; HttpOnly${cookieAttrs}; SameSite=Strict; Path=/; Max-Age=${AUTH_SESSION_HOURS * 3600}`);
  return new Response(null, { status: 302, headers });
}

async function authMe(request, env) {
  const userId = await readUserSession(request, env);
  if (!userId) return Response.json({ ok: false });

  const row = await env.DB.prepare(
    "SELECT display_name, email FROM users WHERE id = ?1 AND google_sub IS NOT NULL"
  ).bind(userId).first();
  if (!row) return Response.json({ ok: false });

  return Response.json({
    ok: true, user_id: userId,
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
    const cookieAttrs = url.protocol === "https:" ? "; Secure" : "";

    try {
      // --- ①撮影投稿 ---
      if (path === "/api/posts" && request.method === "POST") {
        return await createPost(request, env);
      }
      if (path === "/api/posts/delete" && request.method === "POST") {
        return await deletePost(request, env);
      }
      if (path === "/api/nearby" && request.method === "GET") {
        return await nearbyCheck(request, env);
      }

      // --- ②違和感チェック ---
      if (path === "/api/judge/next" && request.method === "GET") {
        return await judgeNext(request, env);
      }
      if (path === "/api/judge/submit" && request.method === "POST") {
        return await judgeSubmit(request, env);
      }

      // --- ③正誤・修正・解説 ---
      if (path === "/api/correct/next" && request.method === "GET") {
        return await correctNext(request, env);
      }
      if (path === "/api/correct/submit" && request.method === "POST") {
        return await correctSubmit(request, env);
      }
      if (path === "/api/correct/vote/next" && request.method === "GET") {
        return await correctVoteNext(request, env);
      }
      if (path === "/api/correct/vote/submit" && request.method === "POST") {
        return await correctVoteSubmit(request, env);
      }

      // --- 閲覧モード ---
      if (path === "/api/map" && request.method === "GET") {
        return await publicMap(request, env);
      }
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

      // --- 画像配信 ---
      //   閲覧可能なのは: (a) 投稿者本人(user_id が一致)、
      //   (b) ②違和感チェックのキュー経由(judge_id。サムネイルのみ、未判定・自分の投稿以外)、
      //   (c) ③修正提案のキュー経由(curator_id。フル解像度可、needs_fix状態のみ)。
      //   店内・商品写真のため、認証なしの直リンクは許可しない(rule1・[流用])。
      if (path.startsWith("/img/")) {
        const key = decodeURIComponent(path.slice(5));
        let authorized = false;

        const userId = String(url.searchParams.get("user_id") || "");
        if (!authorized && UUID_RE.test(userId)) {
          const row = await env.DB.prepare(
            `SELECT 1 FROM posts
              WHERE (src_image_key = ?1 OR src_thumb_key = ?1 OR tgt_image_key = ?1 OR tgt_thumb_key = ?1)
                AND submitter_id = ?2`
          ).bind(key, userId).first();
          authorized = !!row;
        }

        const judgeId = String(url.searchParams.get("judge_id") || "");
        if (!authorized && UUID_RE.test(judgeId)) {
          const row = await env.DB.prepare(
            `SELECT 1 FROM posts
              WHERE (src_thumb_key = ?1 OR tgt_thumb_key = ?1)
                AND status = 'pending_judgment' AND submitter_id <> ?2
                AND NOT EXISTS (SELECT 1 FROM judgments j WHERE j.post_id = posts.id AND j.judge_id = ?2)`
          ).bind(key, judgeId).first();
          authorized = !!row;
        }

        const curatorId = String(url.searchParams.get("curator_id") || "");
        if (!authorized && UUID_RE.test(curatorId)) {
          const row = await env.DB.prepare(
            `SELECT 1 FROM posts
              WHERE (src_image_key = ?1 OR src_thumb_key = ?1 OR tgt_image_key = ?1 OR tgt_thumb_key = ?1)
                AND status = 'needs_fix' AND submitter_id <> ?2`
          ).bind(key, curatorId).first();
          authorized = !!row;
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
                  SUM(status = 'pending_judgment') AS pending,
                  SUM(status = 'needs_fix') AS needs_fix,
                  SUM(status = 'confirmed') AS confirmed
             FROM posts`
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
