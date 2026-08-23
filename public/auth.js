// ユーザーID(匿名UUID)の生成・保持 + 任意のGoogleログインによる端末間同期。
// report.html / judge.html / curate.html / map.html / mypage.html で共有する
// (mesh.js と同じパターン)。
//
// user_id はこれまで通り localStorage が真実の情報源。Googleでログイン済みなら
// /api/auth/me が「本来の user_id」を返すので、ローカル値とズレていれば上書きする
// (= 複数端末で同じユーザーに戻る仕組み)。オフライン等で /api/auth/me が失敗しても
// 投げない — ローカルのゲストIDのまま使い続けられ、フローは止まらない。

const KEY = 'tiuc_user_id';
const INTRO_SEEN_KEY = 'tiuc_intro_seen_v1';

// 初回は説明トップを表示し、同じブラウザの2回目以降は /game を入口にする。
// /game の「TIUCに戻る」から来た場合と ?intro=1 指定時は説明トップを再表示する。
(function routeReturningVisitor() {
  const path = window.location.pathname;
  if (path !== '/' && path !== '/index.html') return;

  const forceIntro = new URLSearchParams(window.location.search).get('intro') === '1';
  let fromGame = false;

  try {
    if (document.referrer) {
      const ref = new URL(document.referrer);
      fromGame =
        ref.origin === window.location.origin &&
        (ref.pathname === '/game' || ref.pathname === '/game.html');
    }
  } catch {
    // referrer を解釈できない場合は通常の訪問として扱う。
  }

  try {
    const alreadySeen = localStorage.getItem(INTRO_SEEN_KEY) === '1';
    if (alreadySeen && !forceIntro && !fromGame) {
      window.location.replace('/game');
      return;
    }
    localStorage.setItem(INTRO_SEEN_KEY, '1');
  } catch {
    // localStorage が使えない場合は従来通りトップページを表示する。
  }
})();

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
