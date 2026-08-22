// =====================================================================
// TIUC: Today is under construction.
// Worker entry point / routing.
// =====================================================================

import { authMe, googleAuthCallback, googleAuthStart } from "./auth";
import { serveImage } from "./images";
import { publicMap } from "./map";
import { createPost, deletePost, nearbyCheck } from "./posts";
import {
	correctNext,
	correctSubmit,
	correctVoteNext,
	correctVoteSubmit,
	judgeNext,
	judgeSubmit,
} from "./review";
import { mypage } from "./user";
import { bad } from "./utils";
import type { AppEnv, CookieAttrs } from "./types";

export default {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const cookieAttrs: CookieAttrs = url.protocol === "https:" ? "; Secure" : "";

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

			// --- Google ログイン ---
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
			if (path.startsWith("/img/")) {
				return await serveImage(request, env);
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
			return bad(
				"サーバ側でエラーが発生しました: " +
					(e instanceof Error ? e.message : String(e)),
				500,
			);
		}
	},
};
