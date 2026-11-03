// Bộ tạo lệnh ESC/POS thuần, không phụ thuộc trình duyệt (test được bằng Node).

const ESC = 0x1b;
const GS = 0x1d;
const BAND_HEIGHT = 255; // nhiều máy in không nhận một lệnh ảnh quá cao, nên cắt thành từng dải

export function concatBytes(parts) {
  const size = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const init = () => Uint8Array.of(ESC, 0x40);
export const feed = (lines = 4) => Uint8Array.of(ESC, 0x64, lines);
export const cut = () => Uint8Array.of(GS, 0x56, 0x42, 0x00);
/** Xung mở ngăn kéo tiền qua cổng RJ11 của máy in. */
export const openDrawer = () => Uint8Array.of(ESC, 0x70, 0x00, 0x19, 0xfa);
export const align = (n) => Uint8Array.of(ESC, 0x61, n);
export const bold = (on) => Uint8Array.of(ESC, 0x45, on ? 1 : 0);
export const textSize = (w, h) => Uint8Array.of(GS, 0x21, ((w - 1) << 4) | (h - 1));

/** Chuyển bitmap 1-bit (bit 1 = chấm đen) thành các lệnh GS v 0. `bits` có độ dài width*height. */
export function raster(bits, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  const parts = [];
  for (let top = 0; top < height; top += BAND_HEIGHT) {
    const rows = Math.min(BAND_HEIGHT, height - top);
    const band = new Uint8Array(8 + bytesPerRow * rows);
    band.set([GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (bits[(top + y) * width + x]) band[8 + y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    parts.push(band);
  }
  return concatBytes(parts);
}

/** Bỏ dấu tiếng Việt cho chế độ in chữ: bảng mã máy in Trung Quốc thường không có đủ dấu. */
export function stripVietnamese(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7e\n]/g, '?');
}

export function asciiBytes(s) {
  const text = stripVietnamese(s);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}

export function toBase64(bytes) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(s);
}
