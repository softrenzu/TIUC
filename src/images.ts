import { UUID_RE } from "./config";
import { bad } from "./utils";
import type { AppEnv } from "./types";

export async function serveImage(request: Request, env: AppEnv): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
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
