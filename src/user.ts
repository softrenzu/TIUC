import { UUID_RE } from "./config";
import { bad } from "./utils";
import type { AppEnv } from "./types";

// 簡易な非線形レベルカーブ(表示用のみ。実効重みは levels テーブルで別管理) [流用]
function pointsCostForLevel(level: number): number {
  return 4 + Math.floor((level - 1) / 3) * 2;
}
function pointsForLevel(level: number): number {
  let p = 0;
  for (let l = 1; l < level; l++) p += pointsCostForLevel(l);
  return p;
}
function levelFromPoints(pointsTotal: number): number {
  let level = 1;
  while (pointsForLevel(level + 1) <= pointsTotal) level++;
  return level;
}

// =====================================================================
// マイページ(本人の履歴)。user_id を知っていることのみを根拠に閲覧可 [流用]
// =====================================================================
export async function mypage(request: Request, env: AppEnv): Promise<Response> {
  const sp = new URL(request.url).searchParams;
  const userId = String(sp.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");

  const [summary, postsRes, eventsRes, levelsRes] = await Promise.all([
    env.DB.prepare(
      `SELECT points_total, post_count, judged_count, corrected_count, adopted_count, streak_count
         FROM users WHERE id = ?1`
    ).bind(userId).first<{
      points_total: number;
      post_count: number;
      judged_count: number;
      corrected_count: number;
      adopted_count: number;
      streak_count: number;
    }>(),
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

