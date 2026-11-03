// Dựng lại bảng hàng từ các từ OCR đọc được (kèm toạ độ), để dùng chung bộ dò cột với Excel.
import { norm } from '../util.js';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Gom các từ cùng hàng ngang, theo tâm dọc; ảnh hơi nghiêng vẫn gom đúng nhờ so với từ cuối của hàng. */
export function groupRows(words) {
  const h = median(words.map((w) => w.y1 - w.y0)) || 10;
  const sorted = [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const rows = [];
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < h * 0.6);
    if (row) {
      row.words.push(w);
      row.cy = (row.cy * (row.words.length - 1) + cy) / row.words.length;
    } else {
      rows.push({ cy, words: [w] });
    }
  }
  rows.sort((a, b) => a.cy - b.cy);
  for (const r of rows) r.words.sort((a, b) => a.x0 - b.x0);
  return { rows, lineHeight: h };
}

/** Tách một hàng thành các ô theo khoảng trống lớn hoặc nét kẻ bảng "|". */
export function splitCells(words, lineHeight) {
  const cells = [];
  let cur = null;
  for (const w of words) {
    const text = w.text.replace(/^[|[\]]+|[|[\]]+$/g, '');
    const isBorder = !text;
    if (isBorder) {
      cur = null;
      continue;
    }
    if (cur && w.x0 - cur.x1 <= lineHeight * 1.1) {
      cur.text += ` ${text}`;
      cur.x1 = w.x1;
      cur.conf = Math.min(cur.conf, w.conf);
    } else {
      cur = { text, x0: w.x0, x1: w.x1, conf: w.conf };
      cells.push(cur);
    }
    if (/[|]$/.test(w.text)) cur = null;
  }
  return cells;
}

const HEADER_HINT = /\b(so luong|s luong|sl|don gia|thanh tien|dvt|ten hang|mat hang|hang hoa)\b/;

/**
 * Chuyển ảnh thành lưới: tìm dòng tiêu đề, lấy vị trí ngang của từng cột tiêu đề,
 * rồi xếp mỗi ô của các dòng sau vào cột gần nhất. Dòng chỉ có chữ ở cột tên là phần
 * xuống dòng của tên hàng phía trên, nên được nối vào.
 */
export function wordsToGrid(words, detectColumns) {
  const { rows, lineHeight } = groupRows(words);
  const cellRows = rows.map((r) => splitCells(r.words, lineHeight));
  const headerIndex = cellRows.findIndex((cells) => {
    if (!HEADER_HINT.test(norm(cells.map((c) => c.text).join(' ')))) return false;
    const found = detectColumns(cells.map((c) => c.text));
    return found.qty !== undefined && (found.name !== undefined || found.code !== undefined || found.barcode !== undefined);
  });
  if (headerIndex < 0) return null;
  const header = cellRows[headerIndex];
  const nameCol = detectColumns(header.map((c) => c.text)).name;
  const centers = header.map((c) => (c.x0 + c.x1) / 2);
  const grid = [header.map((c) => c.text)];
  const lowConf = [false];
  for (const cells of cellRows.slice(headerIndex + 1)) {
    const row = header.map(() => '');
    let minConf = 100;
    for (const c of cells) {
      // Ô chồng lên vùng của cột nào thì thuộc cột đó; không thì lấy cột có tâm gần nhất.
      let best = header.findIndex((hc) => c.x0 <= hc.x1 && c.x1 >= hc.x0);
      if (best < 0) {
        const cx = (c.x0 + c.x1) / 2;
        best = centers.reduce((bi, x, i) => (Math.abs(x - cx) < Math.abs(centers[bi] - cx) ? i : bi), 0);
      }
      row[best] = row[best] ? `${row[best]} ${c.text}` : c.text;
      minConf = Math.min(minConf, c.conf);
    }
    const filled = row.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const prev = grid.length - 1;
    if (filled.length === 1 && filled[0] === nameCol && prev > 0 && !/\d/.test(row[nameCol])) {
      grid[prev][nameCol] = `${grid[prev][nameCol]} ${row[nameCol]}`.trim();
      continue;
    }
    grid.push(row);
    lowConf.push(minConf < 60);
  }
  return { grid, lowConf, afterTable: cellRows.slice(headerIndex + 1).map((cells) => cells.map((c) => c.text).join(' ')) };
}

const lastNumber = (text, parseNumber) => {
  const all = [...text.matchAll(/\d[\d.,\s]*\d|\d/g)].map((m) => m[0]).filter((s) => !/%/.test(s));
  return all.length ? parseNumber(all.at(-1).replace(/\s/g, '')) : null;
};

/** Các dòng tổng tiền, chiết khấu, thuế và số chứng từ, đọc từ toàn bộ chữ trong ảnh. */
export function documentFields(text, parseNumber) {
  const out = { grand_total: null, discount: null, vat_amount: null, invoice_number: '', invoice_date: '' };
  // "Tổng thanh toán" là số cuối cùng phải trả; "Tổng cộng" có thể là tiền hàng trước chiết khấu.
  const TOTAL_LABELS = [/thanh toan|phai tra/, /tong cong/, /tong tien/];
  let totalRank = TOTAL_LABELS.length;
  for (const line of text.split(/\r?\n/)) {
    const n = norm(line);
    const rank = /\btong\b|thanh toan|phai tra/.test(n) ? TOTAL_LABELS.findIndex((re) => re.test(n)) : -1;
    if (rank >= 0) {
      const v = lastNumber(line, parseNumber);
      if (v !== null && rank < totalRank) [out.grand_total, totalRank] = [v, rank];
    } else if (out.discount === null && /(chiet khau|giam gia)/.test(n)) out.discount = lastNumber(line, parseNumber);
    else if (out.vat_amount === null && /(tien thue|thue gtgt|\bvat\b)/.test(n)) {
      const v = lastNumber(line, parseNumber);
      out.vat_amount = v !== null && v > 100 ? v : null; // bỏ con số thuế suất như 8 hay 10
    }
    if (!out.invoice_number) {
      const m = /\b(?:so|so hd|so hoa don|so phieu)\s*[:.]?\s*([a-z0-9][a-z0-9/-]{1,})/.exec(n);
      if (m && /\d/.test(m[1])) out.invoice_number = m[1].toUpperCase();
    }
    if (!out.invoice_date) {
      const d = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(line);
      if (d) out.invoice_date = `${d[1].padStart(2, '0')}/${d[2].padStart(2, '0')}/${d[3].length === 2 ? `20${d[3]}` : d[3]}`;
    }
  }
  return out;
}

const UNITS = new Set(['cai', 'chiec', 'lon', 'chai', 'goi', 'hop', 'thung', 'loc', 'tui', 'bich', 'kg', 'g', 'l', 'ml', 'cay', 'vi', 'bo', 'doi', 'cuon', 'met', 'm', 'bao', 'can', 'hu', 'lo', 'tuyp', 'qua', 'trai']);

/**
 * Khi không thấy dòng tiêu đề: đọc từng dòng dạng "STT Tên hàng ĐVT SL Đơn giá Thành tiền",
 * lấy các số ở cuối dòng và nhận ra bộ ba số lượng × đơn giá = thành tiền.
 */
export function freeformLines(text, parseNumber) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[|]/g, ' ').trim();
    const tokens = line.split(/\s+/).filter(Boolean);
    const nums = [];
    let i = tokens.length - 1;
    for (; i >= 0; i -= 1) {
      // "168 000" bị OCR tách đôi: nhóm 3 chữ số đứng sau một số khác được nối lại.
      if (/^\d{3}$/.test(tokens[i]) && i > 0 && /^\d[\d.,]*$/.test(tokens[i - 1])) {
        tokens[i - 1] += tokens[i];
        continue;
      }
      const v = /^\d[\d.,]*$/.test(tokens[i]) ? parseNumber(tokens[i]) : null;
      if (v === null) break;
      nums.unshift(v);
    }
    if (nums.length < 2) continue;
    let name = tokens.slice(0, i + 1);
    if (name.length && /^\d{1,3}[.)]?$/.test(name[0])) name = name.slice(1); // số thứ tự
    const unit = name.length > 1 && UNITS.has(norm(name.at(-1))) ? name.pop() : '';
    if (!name.join('').replace(/[^\p{L}]/gu, '')) continue;
    let qty = null;
    let price = null;
    let total = null;
    for (let k = nums.length - 3; k >= 0 && qty === null; k -= 1) {
      const [a, b, c] = nums.slice(k, k + 3);
      if (c > 0 && Math.abs(a * b - c) <= Math.max(c * 0.01, 1)) [qty, price, total] = [a, b, c];
    }
    if (qty === null) {
      const [a, b] = nums.slice(-2);
      if (a < 1000) [qty, price] = [a, b];
      else [price, total] = [a, b];
    }
    out.push({ name: name.join(' '), unit, qty, unit_price: price, line_total: total, confirmed: total !== null && qty !== null && price !== null });
  }
  return out;
}

/** OCR đôi khi nối chữ của hai ô cạnh nhau thành một từ; tách lại theo vị trí từng ký tự. */
function splitAcrossColumns(word, cols) {
  const inner = cols.filter((x) => x > word.x0 && x < word.x1);
  if (!inner.length || !word.symbols?.length) return [word];
  const parts = [];
  for (const sym of word.symbols) {
    const cx = (sym.x0 + sym.x1) / 2;
    const slot = inner.filter((x) => x < cx).length;
    parts[slot] ??= { ...word, text: '', x0: sym.x0, x1: sym.x1, symbols: [] };
    parts[slot].text += sym.text;
    parts[slot].x1 = sym.x1;
  }
  return parts.filter((p) => p && p.text.trim());
}

/**
 * Xếp chữ OCR vào lưới tạo bởi các đường kẻ bảng. Một ô giữa hai đường kẻ ngang có thể chứa
 * nhiều dòng hàng (bảng chỉ kẻ dọc), nên mỗi dòng chữ là một hàng; dòng chỉ có chữ ở một ô và
 * không có số là phần xuống dòng của ô đó ở hàng trên.
 */
export function wordsToTableGrid(words, { rows, cols }) {
  const { rows: textRows } = groupRows(words);
  const colOf = (cx) => cols.findIndex((x, i) => i < cols.length - 1 && cx >= x && cx < cols[i + 1]);
  const grid = [];
  const lowConf = [];
  let prevBand = -1;
  for (const tr of textRows) {
    const band = rows.findIndex((y, i) => i < rows.length - 1 && tr.cy >= y && tr.cy < rows[i + 1]);
    if (band < 0) continue;
    const cells = Array(cols.length - 1).fill('');
    let minConf = 100;
    let any = false;
    for (const w of tr.words.flatMap((word) => splitAcrossColumns(word, cols))) {
      const text = w.text.replace(/^[|[\]]+|[|[\]]+$/g, '');
      const c = colOf((w.x0 + w.x1) / 2);
      if (!text || c < 0) continue;
      cells[c] = cells[c] ? `${cells[c]} ${text}` : text;
      minConf = Math.min(minConf, w.conf);
      any = true;
    }
    if (!any) continue;
    const filled = cells.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const prev = grid.at(-1);
    if (prev && band === prevBand && filled.length === 1 && !/\d/.test(cells[filled[0]]) && prev[filled[0]]) {
      prev[filled[0]] += ` ${cells[filled[0]]}`;
      continue;
    }
    grid.push(cells);
    lowConf.push(minConf < 60);
    prevBand = band;
  }
  return { grid, lowConf };
}
