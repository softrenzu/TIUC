// ユーザーID(匿名UUID)の生成・保持 + 任意のGoogleログインによる端末間同期。
// report.html / judge.html / curate.html / map.html / mypage.html で共有する
// (mesh.js と同じパターン)。
//
// user_id はこれまで通り localStorage が真実の情報源。Googleでログイン済みなら
// /api/auth/me が「本来の user_id」を返すので、ローカル値とズレていれば上書きする
// (= 複数端末で同じユーザーに戻る仕組み)。オフライン等で /api/auth/me が失敗しても
// 投げない — ローカルのゲストIDのまま使い続けられ、フローは止まらない。

const KEY = 'tiuc_user_id';

export function getUserId() {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export function setUserId(id) {
  localStorage.setItem(KEY, id);
}

export function googleLoginUrl(userId) {
  return `/api/auth/google/start?user_id=${encodeURIComponent(userId)}`;
}

export async function bootstrapAuth() {
  let userId = getUserId();
  let session = null;
  try {
    const res = await fetch('/api/auth/me');
    const j = await res.json();
    if (j.ok) {
      session = j;
      if (j.user_id !== userId) {
        userId = j.user_id;
        setUserId(userId);
      }
    }
  } catch {
    // オフライン等 -- ローカルのゲストIDのまま続行する
  }
  return { userId, session };
}
