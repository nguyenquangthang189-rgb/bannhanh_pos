export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const bad = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'Không tìm thấy dữ liệu') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

const pad = (n) => String(n).padStart(2, '0');

/** Giờ địa phương của máy chủ, dạng 'YYYY-MM-DD HH:MM:SS' để SQLite date() dùng trực tiếp. */
export function now(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export const today = () => now().slice(0, 10);

export const round3 = (x) => Math.round(x * 1000) / 1000;

/** Tiền là số nguyên VND không âm. */
export function toMoney(v, label = 'Số tiền') {
  const n = Number(v ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw bad(`${label} không hợp lệ`);
  return n;
}

/** Số lượng > 0, tối đa 3 chữ số thập phân (hàng cân ký). */
export function toQty(v, label = 'Số lượng') {
  const n = round3(Number(v));
  if (!Number.isFinite(n) || n <= 0) throw bad(`${label} phải lớn hơn 0`);
  return n;
}

export function toText(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

export function required(v, label) {
  const s = toText(v);
  if (!s) throw bad(`Vui lòng nhập ${label}`);
  return s;
}

/** Bỏ dấu tiếng Việt, để tìm "ao thun" ra "Áo thun". */
export function norm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

export function likeParam(q) {
  return `%${norm(q).replace(/[\\%_]/g, '\\$&')}%`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Khoảng ngày từ query; `to` là mốc mở (ngày kế tiếp 00:00:00) để so sánh với created_at. */
export function dateRange(query) {
  const from = DATE_RE.test(query.from ?? '') ? query.from : today();
  const to = DATE_RE.test(query.to ?? '') ? query.to : today();
  if (from > to) throw bad('Khoảng ngày không hợp lệ');
  const end = new Date(`${to}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return { from, to, start: `${from} 00:00:00`, end: now(end) };
}

export function paging(query, defLimit = 30) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defLimit, 1), 1000);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}
