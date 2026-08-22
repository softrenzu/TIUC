import { meshCodes } from "../public/mesh.js";

import {
	LANG_PAIRS,
	LOC_SOURCES,
	MAX_IMAGE_BYTES,
	POINTS_POST_SUBMIT,
	POST_HOURLY_LIMIT,
	POST_PLACE_KINDS,
	UUID_RE,
} from "./config";

import { bad, sha256Short } from "./utils";
import type { AppEnv } from "./types";

// =====================================================================
// ①撮影投稿モード
// =====================================================================

export async function createPost(request: Request, env: AppEnv): Promise<Response> {
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

  // 可変投稿フロー(2026-08-22改定): 見つけた外国語表記の写真(src)は必須、
  // 日本語原文の写真(tgt)は任意(1枚に両方写っていてもよい)
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
  ).bind(userId, now).first<{ n: number }>();
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
  if (tgtFull instanceof File && tgtThumb instanceof File && tgtImageKey && tgtThumbKey) {
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
export async function nearbyCheck(request: Request, env: AppEnv): Promise<Response> {
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
export async function deletePost(request: Request, env: AppEnv): Promise<Response> {
  const body = await request.json<Record<string, unknown>>();
  const userId = String(body.user_id || "");
  const postId = String(body.post_id || "");
  if (!UUID_RE.test(userId) || !postId) return bad("パラメータが不正です");

  const row = await env.DB.prepare(
    `SELECT p.submitter_id, p.status, p.src_image_key, p.src_thumb_key,
            p.tgt_image_key, p.tgt_thumb_key,
            (SELECT COUNT(*) FROM judgments WHERE post_id = p.id) AS judge_n
       FROM posts p WHERE p.id = ?1`
  ).bind(postId).first<{
    submitter_id: string;
    status: string;
    src_image_key: string;
    src_thumb_key: string;
    tgt_image_key: string | null;
    tgt_thumb_key: string | null;
    judge_n: number;
  }>();
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

