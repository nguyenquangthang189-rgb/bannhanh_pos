// Làm sạch ảnh chứng từ trước khi OCR: xoay thẳng, chuyển đen trắng theo ánh sáng từng vùng,
// tìm đường kẻ bảng (để biết hàng/cột) rồi xóa chúng đi vì đường kẻ làm OCR đọc sai chữ số.
import { decodePngGray, encodePngGray } from './png.js';

const INK = 1;

/**
 * Ngưỡng thích nghi (trung bình vùng lân cận) để ảnh chụp có chỗ sáng chỗ tối vẫn tách được chữ.
 * `flat` là ảnh xám đã san phẳng nền (chia cho độ sáng vùng): giữ nét mịn của chữ cho OCR,
 * vì ảnh đen trắng thuần làm dính các chữ cạnh nhau.
 */
function binarize({ width: w, height: h, data }) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < w; x += 1) {
      rowSum += data[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
    }
  }
  const r = Math.max(8, Math.round(Math.min(w, h) / 40));
  const ink = new Uint8Array(w * h);
  const flat = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const v = data[y * w + x];
      ink[y * w + x] = v < mean * 0.85 && v < 200 ? INK : 0;
      flat[y * w + x] = Math.min(255, Math.round((v / Math.max(mean, 1)) * 245));
    }
  }
  return { ink, flat };
}

/** Góc nghiêng (độ) làm các dòng chữ thẳng nhất: hình chiếu theo hàng ngang có phương sai lớn nhất. */
function estimateSkew(ink, w, h) {
  const points = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (ink[y * w + x]) points.push(x, y);
  if (points.length < 200) return 0;
  const step = Math.max(1, Math.floor(points.length / 2 / 60000)) * 2;
  let best = 0;
  let bestScore = -1;
  for (let deg = -5; deg <= 5.001; deg += 0.2) {
    const t = Math.tan((deg * Math.PI) / 180);
    const hist = new Float64Array(h * 2);
    for (let i = 0; i < points.length; i += step) {
      const row = Math.round(points[i + 1] - points[i] * t) + h / 2;
      if (row >= 0 && row < hist.length) hist[Math.floor(row)] += 1;
    }
    let score = 0;
    for (const v of hist) score += v * v;
    if (score > bestScore) [bestScore, best] = [score, deg];
  }
  return best;
}

/** Xoay ảnh để đường có độ dốc `deg` thành nằm ngang (nội suy song tuyến, nền trắng). */
function rotate({ width: w, height: h, data }, deg) {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = w / 2;
  const cy = h / 2;
  const out = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = cos * (x - cx) - sin * (y - cy) + cx;
      const sy = sin * (x - cx) + cos * (y - cy) + cy;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * w + x0;
      out[y * w + x] = (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy;
    }
  }
  return { width: w, height: h, data: out };
}

/** Đoạn mực dài nhất trên một hàng (hoặc cột), cho phép đứt quãng ngắn do ảnh mờ. */
function longestRun(get, length, maxGap) {
  let best = { len: 0, start: 0, end: 0 };
  let start = -1;
  let lastInk = -1;
  for (let i = 0; i < length; i += 1) {
    if (!get(i)) continue;
    if (start < 0 || i - lastInk > maxGap) start = i;
    lastInk = i;
    if (i - start + 1 > best.len) best = { len: i - start + 1, start, end: i };
  }
  return best;
}

/** Gộp các hàng/cột liền kề đều là đường kẻ thành một đường, lấy vị trí giữa. */
function collapse(positions) {
  const lines = [];
  for (const p of positions) {
    const last = lines.at(-1);
    if (last && p.at - last.b <= 3) {
      last.b = p.at;
      last.start = Math.min(last.start, p.start);
      last.end = Math.max(last.end, p.end);
    } else lines.push({ a: p.at, b: p.at, start: p.start, end: p.end });
  }
  return lines.map((l) => ({ ...l, pos: (l.a + l.b) / 2 }));
}

function findLines(ink, w, h) {
  const horizontal = [];
  for (let y = 0; y < h; y += 1) {
    const run = longestRun((x) => ink[y * w + x], w, 4);
    if (run.len >= w * 0.25) horizontal.push({ at: y, ...run });
  }
  const vertical = [];
  for (let x = 0; x < w; x += 1) {
    const run = longestRun((y) => ink[y * w + x], h, 4);
    if (run.len >= Math.max(h * 0.06, 50)) vertical.push({ at: x, ...run });
  }
  return { h: collapse(horizontal), v: collapse(vertical) };
}

/**
 * Ảnh PNG -> ảnh đen trắng đã xoay thẳng và xóa đường kẻ (PNG), kèm lưới bảng nếu có:
 * rows/cols là toạ độ các đường kẻ, dùng để xếp chữ OCR vào đúng ô.
 */
export function prepareImage(png) {
  let gray = decodePngGray(png);
  if (!gray) return null;
  let { ink, flat } = binarize(gray);
  const skew = estimateSkew(ink, gray.width, gray.height);
  if (Math.abs(skew) >= 0.2) {
    gray = rotate(gray, skew);
    ({ ink, flat } = binarize(gray));
  }
  const { width: w, height: h } = gray;
  const lines = findLines(ink, w, h);
  const clean = flat;
  // Xóa đường kẻ, nới thêm 1 điểm ảnh để không còn viền mờ dính vào chữ.
  for (const l of lines.h) {
    for (let y = Math.max(0, l.a - 1); y <= Math.min(h - 1, l.b + 1); y += 1) for (let x = l.start; x <= l.end; x += 1) clean[y * w + x] = 255;
  }
  for (const l of lines.v) {
    for (let x = Math.max(0, l.a - 1); x <= Math.min(w - 1, l.b + 1); x += 1) for (let y = l.start; y <= l.end; y += 1) clean[y * w + x] = 255;
  }
  const grid = lines.h.length >= 2 && lines.v.length >= 3
    ? { rows: lines.h.map((l) => l.pos), cols: lines.v.map((l) => l.pos) }
    : null;
  return { png: encodePngGray({ width: w, height: h, data: clean }), grid, skew, width: w, height: h };
}
