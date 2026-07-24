// EXIF 解析(依存ライブラリなし)
// JPEG の APP1 セグメントから GPS・撮影日時・Orientation だけを取り出す。
// ファイル先頭 128KB を渡せば足りる。

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readEntries(dv, tiff, ifdOffset, le) {
  const out = {};
  const n = dv.getUint16(ifdOffset, le);
  for (let i = 0; i < n; i++) {
    const e = ifdOffset + 2 + i * 12;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const count = dv.getUint32(e + 4, le);
    const bytes = (TYPE_SIZE[type] || 1) * count;
    const valOff = bytes > 4 ? tiff + dv.getUint32(e + 8, le) : e + 8;
    out[tag] = { type, count, valOff };
  }
  return out;
}

function readValue(dv, entry, le) {
  const { type, count, valOff } = entry;
  if (type === 2) {
    let s = '';
    for (let i = 0; i < count; i++) {
      const c = dv.getUint8(valOff + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  if (type === 3) return dv.getUint16(valOff, le);
  if (type === 4) return dv.getUint32(valOff, le);
  if (type === 5 || type === 10) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const o = valOff + i * 8;
      const num = type === 5 ? dv.getUint32(o, le) : dv.getInt32(o, le);
      const den = type === 5 ? dv.getUint32(o + 4, le) : dv.getInt32(o + 4, le);
      arr.push(den ? num / den : 0);
    }
    return count === 1 ? arr[0] : arr;
  }
  return null;
}

export function parseExif(buffer) {
  const dv = new DataView(buffer);
  const out = {};
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xffd8) return out;

  let offset = 2, app1 = -1;
  while (offset < dv.byteLength - 4) {
    if (dv.getUint8(offset) !== 0xff) break;
    const marker = dv.getUint8(offset + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break;
    const size = dv.getUint16(offset + 2);
    if (marker === 0xe1) { app1 = offset + 4; break; }
    offset += 2 + size;
  }
  if (app1 < 0 || dv.getUint32(app1) !== 0x45786966) return out;

  const tiff = app1 + 6;
  const le = dv.getUint16(tiff) === 0x4949;
  if (dv.getUint16(tiff + 2, le) !== 0x002a) return out;

  const ifd0 = readEntries(dv, tiff, tiff + dv.getUint32(tiff + 4, le), le);
  if (ifd0[0x0112]) out.orientation = readValue(dv, ifd0[0x0112], le);

  if (ifd0[0x8769]) {
    const sub = readEntries(dv, tiff, tiff + readValue(dv, ifd0[0x8769], le), le);
    if (sub[0x9003]) {
      const s = readValue(dv, sub[0x9003], le);
      const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
      if (m) out.observedAt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
  }

  if (ifd0[0x8825]) {
    const gps = readEntries(dv, tiff, tiff + readValue(dv, ifd0[0x8825], le), le);
    const latRef = gps[0x0001] ? readValue(dv, gps[0x0001], le) : null;
    const latVal = gps[0x0002] ? readValue(dv, gps[0x0002], le) : null;
    const lngRef = gps[0x0003] ? readValue(dv, gps[0x0003], le) : null;
    const lngVal = gps[0x0004] ? readValue(dv, gps[0x0004], le) : null;
    if (Array.isArray(latVal) && Array.isArray(lngVal)) {
      const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
      out.lat = dms(latVal) * (latRef === 'S' ? -1 : 1);
      out.lng = dms(lngVal) * (lngRef === 'W' ? -1 : 1);
    }
  }
  return out;
}
