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
