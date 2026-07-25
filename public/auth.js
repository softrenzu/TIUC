// 通報者ID(匿名UUID)の生成・保持 + 任意のGoogleログインによる端末間同期。
// report.html / map.html / mypage.html で共有する(mesh.js と同じパターン)。
//
// reporter_id はこれまで通り localStorage が真実の情報源。Googleでログイン
// 済みなら /api/auth/me が「本来の reporter_id」を返すので、ローカル値と
// ズレていれば上書きする(= 複数端末で同じ通報者に戻る仕組み)。オフライン等で
// /api/auth/me が失敗しても投げない — ローカルのゲストIDのまま使い続けられ、
// 通報フローは止まらない。

const KEY = 'kubiaka_reporter_id';

export function getReporterId() {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export function setReporterId(id) {
  localStorage.setItem(KEY, id);
}

export function googleLoginUrl(reporterId) {
  return `/api/auth/google/start?reporter_id=${encodeURIComponent(reporterId)}`;
}

export async function bootstrapAuth() {
  let reporterId = getReporterId();
  let session = null;
  try {
    const res = await fetch('/api/auth/me');
    const j = await res.json();
    if (j.ok) {
      session = j;
      if (j.reporter_id !== reporterId) {
        reporterId = j.reporter_id;
        setReporterId(reporterId);
      }
    }
  } catch {
    // オフライン等 -- ローカルのゲストIDのまま続行する
  }
  return { reporterId, session };
}
