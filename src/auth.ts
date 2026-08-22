import {
	AUTH_SESSION_HOURS,
	OAUTH_STATE_TTL_SEC,
	UUID_RE,
} from "./config";

import {
	b64url,
	b64urlDecodeUtf8,
	bad,
	enc,
	hmac,
	readCookie,
} from "./utils";

import type { AppEnv, CookieAttrs } from "./types";

// =====================================================================
// ユーザー(市民)ログイン(任意)。ゲスト運用の上に追加するだけ [流用]
// =====================================================================
async function issueUserSession(userId: string, env: AppEnv): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({
    u: userId, exp: Math.floor(Date.now() / 1000) + AUTH_SESSION_HOURS * 3600,
  })));
  return `${payload}.${await hmac(payload, env.AUTH_SECRET)}`;
}

async function readUserSession(request: Request, env: AppEnv): Promise<string | null> {
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

// =====================================================================
// Google ログイン(任意。ゲストと並行して使える) [流用]
// =====================================================================
function googleRedirectUri(request: Request): string {
  return new URL(request.url).origin + "/api/auth/google/callback";
}

export async function googleAuthStart(request: Request, env: AppEnv, cookieAttrs: CookieAttrs): Promise<Response> {
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

export async function googleAuthCallback(request: Request, env: AppEnv, cookieAttrs: CookieAttrs): Promise<Response> {
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

  const googleClientId = env.GOOGLE_CLIENT_ID;
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!googleClientId || !googleClientSecret) {
    return bad("Googleログインは現在利用できません", 503);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      code,
      redirect_uri: googleRedirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return bad("Googleとの認証に失敗しました", 502);
  const token = await tokenRes.json() as {
	access_token?: string;
};
  if (!token.access_token) return bad("Googleとの認証に失敗しました", 502);

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!infoRes.ok) return bad("Googleとの認証に失敗しました", 502);
  const info = await infoRes.json() as {
	sub?: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
};
  const sub = String(info.sub || "");
  if (!sub) return bad("Googleとの認証に失敗しました", 502);
  const email = info.email ? String(info.email) : null;
  const emailVerified = info.email_verified === true;
  const displayName = info.name ? String(info.name).slice(0, 80) : null;
  const now = Math.floor(Date.now() / 1000);

  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE google_sub = ?1"
  ).bind(sub).first<{ id: string }>();

  let userId: string;
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

export async function authMe(request: Request, env: AppEnv): Promise<Response> {
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

