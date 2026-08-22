import {
	CORRECT_HOURLY_LIMIT,
	JUDGE_HOURLY_LIMIT,
	JUDGMENT_THRESHOLD,
	LANG_PAIRS,
	POINTS_CORRECTION_CONFIRM_BONUS,
	POINTS_CORRECTION_PROPOSE,
	POINTS_JUDGMENT,
	POINTS_VOTE,
	UUID_RE,
	VOTE_HOURLY_LIMIT,
	VOTE_THRESHOLD,
} from "./config";

import { bad } from "./utils";
import type { AppEnv } from "./types";

// =====================================================================
// ②違和感チェック(ネイティブ専用サブモード)
//   一タップ・キュー・重み。全体のスループットを決める配車弁。
// =====================================================================

export async function judgeNext(request: Request, env: AppEnv): Promise<Response> {
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

export async function judgeSubmit(request: Request, env: AppEnv): Promise<Response> {
  const body = await request.json<Record<string, unknown>>();
  const userId = String(body.user_id || "");
  const postId = String(body.post_id || "");
  const verdict = String(body.verdict || "");
  const category = body.category ? String(body.category).slice(0, 40) : null;
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  if (!["natural", "unnatural"].includes(verdict)) return bad("判定の指定が不正です");

  const now = Math.floor(Date.now() / 1000);
  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM judgments WHERE judge_id = ?1 AND created_at > ?2 - 3600"
  ).bind(userId, now).first<{ n: number }>();
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
  ).bind(postId).first<{ natural: number | null; unnatural: number | null }>();
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

export async function correctNext(request: Request, env: AppEnv): Promise<Response> {
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

export async function correctSubmit(request: Request, env: AppEnv): Promise<Response> {
  const body = await request.json<Record<string, unknown>>();
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
  ).bind(userId, now).first<{ n: number }>();
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

export async function correctVoteNext(request: Request, env: AppEnv): Promise<Response> {
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

export async function correctVoteSubmit(request: Request, env: AppEnv): Promise<Response> {
  const body = await request.json<Record<string, unknown>>();
  const userId = String(body.user_id || "");
  const correctionId = String(body.correction_id || "");
  const agree = body.agree ? 1 : 0;
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  if (!correctionId) return bad("correction_id が必要です");

  const now = Math.floor(Date.now() / 1000);
  const rate = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM votes WHERE voter_id = ?1 AND created_at > ?2 - 3600"
  ).bind(userId, now).first<{ n: number }>();
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
  ).bind(correctionId).first<{ agree_n: number | null; total: number }>();
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

