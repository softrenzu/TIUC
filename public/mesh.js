// JIS X 0410 地域メッシュコード
// このファイルはブラウザと Worker の両方から読み込まれる。
// サーバ側は必ずここで座標から再計算し、クライアントが送ってきた値は使わない。

export function meshCodes(lat, lng) {
  const p = Math.floor(lat * 60 / 40);
  const a = lat * 60 - p * 40;
  const q = Math.floor(a / 5);
  const b = a - q * 5;
  const r = Math.floor(b * 60 / 30);
  const latRem = b * 60 - r * 30;                 // 0..30 秒

  const u = Math.floor(lng) - 100;
  const f = lng - Math.floor(lng);
  const v = Math.floor(f * 60 / 7.5);
  const g = f * 60 - v * 7.5;
  const w = Math.floor(g * 60 / 45);
  const lngRem = g * 60 - w * 45;                 // 0..45 秒

  const mesh3 = `${p}${u}${q}${v}${r}${w}`;                        // 約 1km
  const q4 = (latRem >= 15 ? 2 : 0) + (lngRem >= 22.5 ? 1 : 0) + 1;
  const mesh4 = `${mesh3}${q4}`;                                    // 約 500m
  const lat2 = latRem % 15;
  const lng2 = lngRem % 22.5;
  const q5 = (lat2 >= 7.5 ? 2 : 0) + (lng2 >= 11.25 ? 1 : 0) + 1;
  const mesh5 = `${mesh4}${q5}`;                                    // 約 250m

  return { mesh3, mesh4, mesh5 };
}

// meshCodes() の逆変換。8/9/10桁のメッシュコードから矩形(緯度経度の範囲)を求める。
// 9桁目(q4)・10桁目(q5)は meshCodes と同じ象限エンコーディング(+2=北半分,+1=東半分)
// なので、その都度矩形を半分に割っていく形で汎用的に扱える。
export function meshBounds(code) {
  code = String(code);
  if (!/^\d{8}$|^\d{9}$|^\d{10}$/.test(code)) {
    throw new Error(`invalid mesh code: ${code}`);
  }
  const p = Number(code.slice(0, 2));
  const u = Number(code.slice(2, 4));
  const q = Number(code.slice(4, 5));
  const v = Number(code.slice(5, 6));
  const r = Number(code.slice(6, 7));
  const w = Number(code.slice(7, 8));

  let latMin = (p * 40 + q * 5) / 60 + (r * 30) / 3600;
  let latSpan = 30 / 3600;
  let lngMin = 100 + u + (v * 7.5) / 60 + (w * 45) / 3600;
  let lngSpan = 45 / 3600;

  for (let i = 8; i < code.length; i++) {
    const n = Number(code[i]) - 1;           // q4/q5 とも 1..4 で同じ規則
    latMin += (n >= 2 ? 1 : 0) * latSpan / 2; // 北半分ビット(+2)
    lngMin += (n % 2) * lngSpan / 2;          // 東半分ビット(+1)
    latSpan /= 2;
    lngSpan /= 2;
  }
  return { latMin, latMax: latMin + latSpan, lngMin, lngMax: lngMin + lngSpan };
}
