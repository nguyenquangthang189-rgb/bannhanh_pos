// Đọc chứng từ nhập hàng (Excel, CSV, ảnh) thành bản nháp. Không ghi gì vào kho:
// người dùng duyệt từng dòng rồi mới tạo phiếu nhập qua POST /api/purchases.
import { all } from '../db.js';
import { HttpError, bad, norm, round3, toText } from '../util.js';
import { readCsv, readXlsx } from '../lib/spreadsheet.js';
import { recognize } from '../lib/ocr.js';
import { prepareImage } from '../lib/image-prep.js';
import { isPng } from '../lib/png.js';
import { wordsToGrid, wordsToTableGrid, documentFields, freeformLines } from '../lib/invoice-text.js';

const MAX_LINES = 500;
const FUZZY_MIN = 0.6;
const LOW_CONFIDENCE = 70;

// ----- Số kiểu Việt Nam -----

/** "12.000" và "12,000" là mười hai nghìn; "1,5" là một phẩy năm. */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value ?? '').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  if (/^-?\d+,\d+$/.test(s)) return Number(s.replace(',', '.'));
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ----- Dò cột trong bảng tính -----

const COLUMNS = {
  barcode: { exact: ['ean'], has: ['ma vach', 'barcode'] },
  code: { exact: ['ma', 'sku'], has: ['ma hang', 'ma sp', 'ma san pham', 'ma hh'] },
  name: { exact: ['ten', 'san pham', 'hang hoa', 'mat hang'], has: ['ten hang', 'ten san pham', 'ten sp', 'ten mat hang', 'dien giai', 'product name'] },
  unit: { exact: ['dvt', 'don vi', 'unit'], has: ['don vi tinh'] },
  qty: { exact: ['sl', 'qty', 'quantity'], has: ['so luong', 's luong', 'sl nhap'] },
  sale: { exact: [], has: ['gia ban'] },
  cost: { exact: ['gia', 'price'], has: ['don gia', 'gia nhap', 'gia von', 'unit price'] },
  total: { exact: ['amount', 'tong'], has: ['thanh tien', 'tong tien'] },
};

export function detectColumns(row) {
  const found = {};
  row.forEach((cell, index) => {
    const h = norm(cell).replace(/[().:/_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!h) return;
    for (const [field, { exact, has }] of Object.entries(COLUMNS)) {
      if (found[field] === undefined && (exact.includes(h) || has.some((x) => h.includes(x)))) {
        found[field] = index;
        return;
      }
    }
  });
  return found;
}

// "Tổng" và "Cộng" chỉ tính khi đứng một mình, để không bỏ sót hàng như "Công tắc điện".
const SUMMARY_ROW = /^(?:(?:tong|cong|total)\s*:?$|(?:tong cong|tong tien|tong so|cong tien|chiet khau|giam gia|thue gtgt|thue vat|vat|phai tra|da tra|con no|bang chu|so tien)\b)/;

/** `uncertain[i]` đánh dấu dòng i của `rows` khó đọc (dùng cho OCR). */
function tableToLines(rows, uncertain = []) {
  for (let h = 0; h < Math.min(rows.length, 30); h += 1) {
    const col = detectColumns(rows[h]);
    const hasIdentity = col.name !== undefined || col.code !== undefined || col.barcode !== undefined;
    if (!hasIdentity || col.qty === undefined) continue;
    const lines = [];
    for (const [offset, row] of rows.slice(h + 1).entries()) {
      const pick = (field) => (col[field] === undefined ? '' : row[col[field]] ?? '');
      const name = toText(pick('name'), 200);
      const code = toText(pick('code'), 40);
      const barcode = toText(pick('barcode'), 64);
      if (!name && !code && !barcode) continue;
      if (!code && !barcode && SUMMARY_ROW.test(norm(name))) continue;
      lines.push(makeLine({
        name, code, barcode, unit: toText(pick('unit'), 20), qty: parseNumber(pick('qty')),
        unit_price: parseNumber(pick('cost')), line_total: parseNumber(pick('total')), sale_price: parseNumber(pick('sale')),
        uncertain: uncertain[h + 1 + offset],
      }));
    }
    return lines;
  }
  return null;
}

/** Chuẩn hóa một dòng và ghi cảnh báo khi các con số trên chứng từ không khớp nhau. */
function makeLine({ name, code, barcode, unit, qty, unit_price: unitPrice, line_total: lineTotal, sale_price: salePrice = null, uncertain = false }) {
  const q = qty !== null && qty > 0 ? round3(qty) : null;
  let cost = unitPrice !== null && unitPrice >= 0 ? Math.round(unitPrice) : null;
  if (cost === null && q && lineTotal > 0) cost = Math.round(lineTotal / q);
  const warnings = [];
  if (q === null) warnings.push('Thiếu số lượng');
  if (cost === null) warnings.push('Thiếu đơn giá');
  if (q && cost !== null && lineTotal > 0 && Math.abs(q * cost - lineTotal) > Math.max(lineTotal * 0.01, 1)) {
    warnings.push(`Thành tiền trên chứng từ là ${Math.round(lineTotal).toLocaleString('vi-VN')}, khác số lượng nhân đơn giá`);
  }
  return {
    name, code: code || '', barcode: barcode || '', unit: unit || '', qty: q, cost,
    sale_price: salePrice > 0 ? Math.round(salePrice) : null, uncertain: Boolean(uncertain), warnings,
  };
}

// ----- Khớp với danh mục hàng hóa -----

const tokens = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter(Boolean));

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

const brief = (p) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit, cost_price: p.cost_price, stock: p.stock });

/** exact và name được chọn sẵn; fuzzy chỉ là gợi ý, vì nhập nhầm mặt hàng sẽ làm sai cả tồn kho lẫn giá vốn. */
export function matchLines(lines) {
  const products = all('SELECT id, code, barcode, name, unit, cost_price, stock FROM products WHERE active = 1 AND track_stock = 1');
  const prepared = products.map((p) => ({ p, normName: norm(p.name), words: tokens(p.name) }));
  return lines.map((line) => {
    const code = line.code.toLowerCase();
    const hit = prepared.find(({ p }) => line.barcode && (p.barcode === line.barcode || p.code === line.barcode))
      ?? prepared.find(({ p }) => code && (p.code.toLowerCase() === code || p.barcode === line.code));
    if (hit) return { ...line, match: 'exact', product: brief(hit.p), candidates: [] };
    const wanted = norm(line.name);
    const sameName = wanted && prepared.filter((x) => x.normName === wanted);
    if (sameName?.length === 1) return { ...line, match: 'name', product: brief(sameName[0].p), candidates: [] };
    const words = tokens(line.name);
    const candidates = prepared
      .map((x) => ({ x, score: similarity(words, x.words) }))
      .filter((c) => c.score >= FUZZY_MIN)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((c) => brief(c.x.p));
    return { ...line, match: candidates.length ? 'fuzzy' : 'none', product: null, candidates };
  });
}

// ----- Đọc ảnh bằng OCR -----

/**
 * Ảnh -> làm sạch -> chữ -> bảng. Thứ tự thử: theo đường kẻ bảng, theo vị trí dòng tiêu đề,
 * cuối cùng là đọc từng dòng theo các số ở cuối dòng.
 */
export async function readInvoiceImage(buf) {
  const prep = prepareImage(buf);
  const ocr = await recognize(prep?.png ?? buf);
  const fields = documentFields(ocr.text, parseNumber);
  let lines = [];
  for (const build of [
    () => prep?.grid && wordsToTableGrid(ocr.words, prep.grid),
    () => wordsToGrid(ocr.words, detectColumns),
  ]) {
    const table = build();
    lines = table ? (tableToLines(table.grid, table.lowConf) ?? []) : [];
    if (lines.length) break;
  }
  if (!lines.length) {
    lines = freeformLines(ocr.text, parseNumber).map((l) => makeLine({
      name: toText(l.name, 200), code: '', barcode: '', unit: toText(l.unit, 20), qty: l.qty,
      unit_price: l.unit_price, line_total: l.line_total, uncertain: !l.confirmed,
    }));
  }
  if (!lines.length) {
    throw new HttpError(422, 'Không tìm thấy dòng hàng nào trong ảnh. Hãy chụp thẳng, đủ sáng, thấy rõ cả bảng hàng và dòng tiêu đề (Tên hàng, Số lượng, Đơn giá)');
  }
  const warnings = [];
  if (ocr.confidence < LOW_CONFIDENCE) warnings.push('Ảnh mờ, nghiêng hoặc thiếu sáng nên chữ đọc được kém chính xác. Hãy đối chiếu kỹ từng dòng với ảnh, hoặc chụp lại.');
  const vat = Math.max(Math.round(fields.vat_amount ?? 0), 0);
  if (vat > 0) warnings.push(`Chứng từ có thuế GTGT ${vat.toLocaleString('vi-VN')} đ. Phiếu nhập không có mục thuế, nên nếu thuế tính vào giá vốn thì hãy cộng vào giá nhập.`);
  return {
    source: 'image',
    lines: matchLines(lines.slice(0, MAX_LINES)),
    supplier_name: '',
    supplier_phone: '',
    supplier: null,
    discount: Math.max(Math.round(fields.discount ?? 0), 0),
    vat,
    doc_total: Math.max(Math.round(fields.grand_total ?? 0), 0),
    note: fields.invoice_number || fields.invoice_date
      ? `Theo chứng từ${fields.invoice_number ? ` số ${fields.invoice_number}` : ''}${fields.invoice_date ? ` ngày ${fields.invoice_date}` : ''}` : '',
    ocr_text: ocr.text,
    ocr_confidence: Math.round(ocr.confidence),
    warnings,
  };
}

function fileResult(filename, buf) {
  const ext = /\.[^.]+$/.exec(filename.toLowerCase())?.[0] ?? '';
  if (ext === '.xls' || buf.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    throw bad('File .xls đời cũ chưa đọc được. Hãy mở bằng Excel và lưu lại dạng .xlsx');
  }
  if (ext !== '.xlsx' && ext !== '.csv') throw bad('Chỉ nhận file .xlsx hoặc .csv');
  const sheets = ext === '.xlsx' ? readXlsx(buf) : readCsv(buf);
  for (const rows of sheets) {
    const lines = tableToLines(rows);
    if (lines?.length) {
      if (lines.length > MAX_LINES) throw bad(`File có ${lines.length} dòng, mỗi phiếu nhập tối đa ${MAX_LINES} dòng`);
      return { source: 'file', lines: matchLines(lines), supplier_name: '', supplier_phone: '', supplier: null, discount: 0, vat: 0, doc_total: 0, note: `Nhập từ file ${toText(filename, 80)}`, warnings: [] };
    }
  }
  throw bad('Không tìm thấy bảng hàng. File cần dòng tiêu đề có cột Tên hàng (hoặc Mã hàng) và Số lượng; hãy dùng file mẫu nếu cần');
}

export function register(r) {
  r.post('/api/purchases/import/file', 'admin', ({ body }) => {
    const buf = Buffer.from(String(body.data ?? ''), 'base64');
    if (!buf.length) throw bad('File rỗng');
    return fileResult(String(body.filename ?? ''), buf);
  });

  r.post('/api/purchases/import/image', 'admin', async ({ body }) => {
    const buf = Buffer.from(String(body.data ?? ''), 'base64');
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!isJpeg && !isPng(buf)) throw bad('Chỉ nhận ảnh JPG hoặc PNG');
    return readInvoiceImage(buf);
  });
}
