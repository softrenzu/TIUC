import { UUID_RE } from "./config";
import { bad } from "./utils";
import type { AppEnv } from "./types";

function xpCostForLevel(level: number): number {
  return 2 + Math.floor((level - 1) / 3);
}
function xpForLevel(level: number): number {
  let xp = 0;
  for (let l = 1; l < level; l++) xp += xpCostForLevel(l);
  return xp;
}
function levelFromXp(total: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= total) level++;
  return level;
}
function characterStage(level: number): string {
  if (level >= 10) return "guide";
  if (level >= 6) return "bird";
  if (level >= 3) return "chick";
  return "egg";
}

async function ensureCharacter(env: AppEnv, userId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, created_at) VALUES (?1,?2) ON CONFLICT(id) DO NOTHING").bind(userId, now),
    env.DB.prepare("INSERT INTO characters (user_id, created_at, updated_at) VALUES (?1,?2,?2) ON CONFLICT(user_id) DO NOTHING").bind(userId, now),
  ]);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO xp_events (user_id, kind, xp, source_key, created_at, note)
     SELECT user_id,
            'activity',
            CASE kind
              WHEN 'post_submit' THEN 5
              WHEN 'judgment' THEN 2
              WHEN 'correction_propose' THEN 3
              WHEN 'correction_confirm_bonus' THEN 15
              WHEN 'vote' THEN 2
              WHEN 'adopt_bonus' THEN 30
              ELSE 0
            END,
            'point:' || id,
            created_at,
            kind
       FROM point_events
      WHERE user_id=?1
        AND kind IN ('post_submit','judgment','correction_propose','correction_confirm_bonus','vote','adopt_bonus')`
  ).bind(userId).run();

  const total = await env.DB.prepare(
    "SELECT COALESCE(SUM(xp),0) AS total FROM xp_events WHERE user_id=?1"
  ).bind(userId).first<{total:number}>();
  const xpTotal = total?.total ?? 0;
  await env.DB.prepare(
    "UPDATE characters SET xp_total=?2,updated_at=?3 WHERE user_id=?1"
  ).bind(userId, xpTotal, now).run();
  return xpTotal;
}

export async function gameCharacter(request: Request, env: AppEnv): Promise<Response> {
  const userId = String(new URL(request.url).searchParams.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  const xpTotal = await ensureCharacter(env, userId);
  const level = levelFromXp(xpTotal);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const recent = await env.DB.prepare(
    "SELECT kind,xp,created_at,note FROM xp_events WHERE user_id=?1 ORDER BY created_at DESC,id DESC LIMIT 20"
  ).bind(userId).all();
  return Response.json({ ok:true, xp_total:xpTotal, level, stage:characterStage(level), xp_into_level:xpTotal-base, xp_for_next_level:next-base, recent:recent.results });
}

type QuestDef = { id:string; title:string; desc:string; reward:number };
const QUESTS: QuestDef[] = [
  { id:"first_post", title:"はじめての発見", desc:"外国語表記を1件投稿する", reward:5 },
  { id:"judge_10", title:"違和感ハンター", desc:"違和感チェックを10件行う", reward:10 },
  { id:"fix_1", title:"ことばの職人", desc:"修正案を1件提出する", reward:10 },
  { id:"confirmed_1", title:"みんなの正解", desc:"自分の修正案が1件確定する", reward:15 },
  { id:"three_languages", title:"三言語チャレンジ", desc:"英語・中国語・韓国語をすべて発見する", reward:20 },
  { id:"zukan_12", title:"街ことば図鑑コンプリート", desc:"12種類の言語×表記カテゴリを埋める", reward:25 },
];

async function questDone(env: AppEnv, userId: string, id: string): Promise<boolean> {
  if (id === "first_post") {
    const r = await env.DB.prepare("SELECT post_count AS n FROM users WHERE id=?1").bind(userId).first<{n:number}>();
    return (r?.n ?? 0) >= 1;
  }
  if (id === "judge_10") {
    const r = await env.DB.prepare("SELECT judged_count AS n FROM users WHERE id=?1").bind(userId).first<{n:number}>();
    return (r?.n ?? 0) >= 10;
  }
  if (id === "fix_1") {
    const r = await env.DB.prepare("SELECT corrected_count AS n FROM users WHERE id=?1").bind(userId).first<{n:number}>();
    return (r?.n ?? 0) >= 1;
  }
  if (id === "confirmed_1") {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM point_events WHERE user_id=?1 AND kind='correction_confirm_bonus'").bind(userId).first<{n:number}>();
    return (r?.n ?? 0) >= 1;
  }
  if (id === "three_languages") {
    const r = await env.DB.prepare("SELECT COUNT(DISTINCT lang_pair) AS n FROM posts WHERE submitter_id=?1").bind(userId).first<{n:number}>();
    return (r?.n ?? 0) >= 3;
  }
  if (id === "zukan_12") {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM (SELECT DISTINCT lang_pair,place_kind FROM posts WHERE submitter_id=?1 AND place_kind<>'unknown')").bind(userId).first<{n:number}>();
    return (r?.n ?? 0) >= 12;
  }
  return false;
}

export async function gameQuests(request: Request, env: AppEnv): Promise<Response> {
  const userId = String(new URL(request.url).searchParams.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  await ensureCharacter(env, userId);
  const claims = await env.DB.prepare("SELECT quest_id FROM quest_claims WHERE user_id=?1").bind(userId).all<{quest_id:string}>();
  const claimed = new Set(claims.results.map((x) => x.quest_id));
  const out = [];
  for (const q of QUESTS) out.push({ ...q, done: await questDone(env,userId,q.id), claimed: claimed.has(q.id) });
  return Response.json({ ok:true, quests:out });
}

export async function gameClaimQuest(request: Request, env: AppEnv): Promise<Response> {
  const body = await request.json<Record<string,unknown>>();
  const userId = String(body.user_id || "");
  const questId = String(body.quest_id || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  const q = QUESTS.find((x) => x.id === questId);
  if (!q) return bad("クエストが不正です");
  if (!(await questDone(env,userId,questId))) return bad("まだ達成していません");
  await ensureCharacter(env,userId);
  const already = await env.DB.prepare("SELECT 1 FROM quest_claims WHERE user_id=?1 AND quest_id=?2").bind(userId,questId).first();
  if (already) return bad("受け取り済みです");
  const now = Math.floor(Date.now()/1000);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO quest_claims (user_id,quest_id,claimed_at) VALUES (?1,?2,?3)").bind(userId,questId,now),
    env.DB.prepare("INSERT INTO xp_events (user_id,kind,xp,source_key,created_at,note) VALUES (?1,'quest',?2,?3,?4,?5)").bind(userId,q.reward,`quest:${questId}`,now,q.title),
  ]);
  const xpTotal = await ensureCharacter(env,userId);
  return Response.json({ ok:true, reward:q.reward, xp_total:xpTotal });
}

export async function gameEncyclopedia(request: Request, env: AppEnv): Promise<Response> {
  const userId = String(new URL(request.url).searchParams.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  const rows = await env.DB.prepare("SELECT lang_pair,place_kind,COUNT(*) AS n FROM posts WHERE submitter_id=?1 AND place_kind<>'unknown' GROUP BY lang_pair,place_kind").bind(userId).all();
  return Response.json({ ok:true, slots:rows.results, total:rows.results.length, max:12 });
}

export async function gameImpact(request: Request, env: AppEnv): Promise<Response> {
  const userId = String(new URL(request.url).searchParams.get("user_id") || "");
  if (!UUID_RE.test(userId)) return bad("ユーザーIDが不正です");
  const latest = await env.DB.prepare("SELECT mesh3 FROM posts WHERE submitter_id=?1 ORDER BY created_at DESC LIMIT 1").bind(userId).first<{mesh3:string}>();
  if (!latest) return Response.json({ ok:true, region:null });
  const since = Math.floor(Date.now()/1000) - 30*86400;
  const stats = await env.DB.prepare(`SELECT COUNT(*) AS posts, SUM(status='confirmed') AS confirmed, SUM(status='adopted') AS adopted, COUNT(DISTINCT submitter_id) AS people FROM posts WHERE mesh3=?1 AND created_at>=?2`).bind(latest.mesh3,since).first();
  const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE mesh3=?1 AND submitter_id=?2 AND created_at>=?3").bind(latest.mesh3,userId,since).first<{n:number}>();
  const ahead = await env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT submitter_id,COUNT(*) c FROM posts WHERE mesh3=?1 AND created_at>=?2 GROUP BY submitter_id HAVING c>?3)`).bind(latest.mesh3,since,mine?.n ?? 0).first<{n:number}>();
  return Response.json({ ok:true, region:{ mesh3:latest.mesh3, ...stats, my_posts:mine?.n ?? 0, rank:(ahead?.n ?? 0)+1 } });
}
