// Nội dung hóa đơn được dựng thành danh sách dòng trừu tượng, rồi kết xuất ra HTML, ảnh hoặc chữ.
import { esc, money, qtyFmt, fmtDateTime, METHOD_LABEL } from '../core.js';
import { code128Modules, code128Svg } from './barcode.js';
import { stripVietnamese } from './escpos.js';

export function buildReceipt(inv, settings) {
  const { store, receipt } = settings;
  const lines = [];
  const add = (type, props = {}) => lines.push({ type, ...props });
  add('center', { text: store.name, bold: true, size: 1.35 });
  if (store.address) add('center', { text: store.address, size: 0.9 });
  if (store.phone) add('center', { text: `ĐT: ${store.phone}`, size: 0.9 });
  if (store.tax_code) add('center', { text: `MST: ${store.tax_code}`, size: 0.9 });
  add('gap');
  add('center', { text: receipt.title, bold: true, size: 1.2 });
  add('center', { text: `Số: ${inv.code}` });
  add('center', { text: fmtDateTime(inv.created_at), size: 0.9 });
  if (inv.status === 'cancelled') add('center', { text: '*** ĐÃ HỦY ***', bold: true, size: 1.2 });
  add('gap');
  add('row', { left: 'Thu ngân:', right: inv.user_name ?? '' });
  add('row', { left: 'Khách hàng:', right: inv.customer_name ?? 'Khách lẻ' });
  if (inv.customer_phone) add('row', { left: 'Điện thoại:', right: inv.customer_phone });
  add('hr');
  inv.items.forEach((item, i) => {
    add('text', { text: `${i + 1}. ${item.name}` });
    add('row', { left: `   ${qtyFmt(item.qty)} ${item.unit} x ${money(item.price)}`, right: money(item.qty * item.price) });
    if (item.discount) add('row', { left: '   Giảm giá', right: `-${money(item.discount)}` });
  });
  add('hr');
  add('row', { left: 'Tiền hàng:', right: money(inv.subtotal) });
  if (inv.discount) add('row', { left: 'Giảm giá:', right: `-${money(inv.discount)}` });
  if (inv.tax) add('row', { left: `Thuế GTGT (${inv.tax_rate}%):`, right: money(inv.tax) });
  add('row', { left: 'TỔNG CỘNG:', right: money(inv.total), bold: true, size: 1.25 });
  add('row', { left: `Khách trả (${METHOD_LABEL[inv.method] ?? inv.method}):`, right: money(inv.received) });
  if (inv.change_due) add('row', { left: 'Tiền thừa:', right: money(inv.change_due) });
  if (inv.debt) add('row', { left: 'Còn nợ:', right: money(inv.debt), bold: true });
  if (inv.note) add('text', { text: `Ghi chú: ${inv.note}`, size: 0.9 });
  add('gap');
  if (receipt.show_barcode) add('barcode', { text: inv.code });
  if (receipt.footer) add('center', { text: receipt.footer, size: 0.9 });
  return lines;
}

export function buildTestReceipt(settings) {
  return [
    { type: 'center', text: settings.store.name, bold: true, size: 1.35 },
    { type: 'center', text: 'IN THỬ MÁY IN', bold: true, size: 1.2 },
    { type: 'hr' },
    { type: 'text', text: 'Tiếng Việt: Ăn quả nhớ kẻ trồng cây. ẮẰẲẴẶ ĐƯƠ ệộữợ' },
    { type: 'row', left: 'Dòng trái', right: '1.234.567' },
    { type: 'row', left: 'Tổng cộng', right: '9.999.000', bold: true, size: 1.25 },
    { type: 'barcode', text: 'BANNHANH01' },
    { type: 'center', text: 'Nếu bạn đọc được dấu ở trên, máy in đã sẵn sàng.', size: 0.9 },
  ];
}

// ----- Kết xuất HTML (in qua driver của trình duyệt) -----
export function receiptHtml(lines, paper = 80) {
  const body = lines.map((l) => {
    const style = `${l.bold ? 'font-weight:700;' : ''}${l.size ? `font-size:${l.size}em;` : ''}`;
    switch (l.type) {
      case 'center': return `<div class="c" style="${style}">${esc(l.text)}</div>`;
      case 'text': return `<div style="${style}">${esc(l.text)}</div>`;
      case 'row': return `<div class="r" style="${style}"><span>${esc(l.left)}</span><span>${esc(l.right)}</span></div>`;
      case 'hr': return '<hr>';
      case 'gap': return '<div class="g"></div>';
      case 'barcode': return `<div class="b">${code128Svg(l.text, { height: 40 })}<div>${esc(l.text)}</div></div>`;
      default: return '';
    }
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${paper}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: #fff; color: #000; }
    body { width: ${paper}mm; padding: 2mm 3mm; font: ${paper === 58 ? 11 : 12}px/1.35 Arial, sans-serif; }
    .c { text-align: center; }
    .r { display: flex; justify-content: space-between; gap: 8px; }
    .r span:last-child { white-space: nowrap; }
    hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
    .g { height: 6px; }
    .b { text-align: center; font-size: 10px; margin: 4px 0; }
    .b svg { width: 60%; height: 36px; display: block; margin: 0 auto 2px; }
  </style></head><body>${body}</body></html>`;
}

// ----- Kết xuất ảnh: giữ đúng dấu tiếng Việt trên mọi máy in nhiệt -----
function wrapText(ctx, text, maxWidth) {
  const out = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    const attempt = line ? `${line} ${word}` : word;
    if (ctx.measureText(attempt).width <= maxWidth || !line) line = attempt;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

export function receiptCanvas(lines, paper = 80) {
  const width = paper === 58 ? 384 : 576; // số chấm khả dụng của khổ giấy ở 203 dpi
  const base = paper === 58 ? 22 : 26;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 6000;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, canvas.height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  let y = 4;
  const setFont = (l) => {
    const px = Math.round(base * (l.size ?? 1));
    ctx.font = `${l.bold ? '700' : '400'} ${px}px Arial, "Segoe UI", sans-serif`;
    return Math.round(px * 1.28);
  };
  for (const l of lines) {
    const lh = setFont(l);
    if (l.type === 'center') {
      for (const t of wrapText(ctx, l.text, width - 8)) {
        ctx.textAlign = 'center';
        ctx.fillText(t, width / 2, y);
        y += lh;
      }
    } else if (l.type === 'text') {
      ctx.textAlign = 'left';
      for (const t of wrapText(ctx, l.text, width - 8)) {
        ctx.fillText(t, 2, y);
        y += lh;
      }
    } else if (l.type === 'row') {
      const rightWidth = ctx.measureText(l.right).width;
      ctx.textAlign = 'right';
      ctx.fillText(l.right, width - 2, y);
      ctx.textAlign = 'left';
      for (const t of wrapText(ctx, l.left, width - rightWidth - 16)) {
        ctx.fillText(t, 2, y);
        y += lh;
      }
    } else if (l.type === 'hr') {
      for (let x = 0; x < width; x += 10) ctx.fillRect(x, y + 6, 6, 2);
      y += 14;
    } else if (l.type === 'gap') {
      y += 10;
    } else if (l.type === 'barcode') {
      const modules = code128Modules(l.text);
      const unit = Math.max(Math.floor((width - 40) / modules.length), 1);
      const x0 = Math.floor((width - modules.length * unit) / 2);
      y += 6;
      modules.forEach((black, i) => { if (black) ctx.fillRect(x0 + i * unit, y, unit, 64); });
      y += 68;
      ctx.font = `400 ${Math.round(base * 0.8)}px Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(l.text, width / 2, y);
      y += Math.round(base * 1.2);
    }
  }
  const out = document.createElement('canvas');
  out.width = width;
  out.height = y + 8;
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out;
}

export function canvasToBits(canvas, threshold = 150) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  const bits = new Uint8Array(width * height);
  for (let i = 0; i < bits.length; i += 1) {
    const p = i * 4;
    bits[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114 < threshold ? 1 : 0;
  }
  return { bits, width, height };
}

// ----- Kết xuất chữ thuần: nhanh hơn ảnh, dùng cho máy in cũ, nhưng không có dấu -----
export function receiptText(lines, paper = 80) {
  const cols = paper === 58 ? 32 : 48;
  const out = [];
  const pushWrapped = (s, center) => {
    const words = stripVietnamese(s).split(' ');
    let line = '';
    const flush = () => {
      out.push(center ? ' '.repeat(Math.max(Math.floor((cols - line.length) / 2), 0)) + line : line);
      line = '';
    };
    for (const w of words) {
      if (line && line.length + w.length + 1 > cols) flush();
      line = line ? `${line} ${w}` : w;
    }
    if (line) flush();
  };
  for (const l of lines) {
    if (l.type === 'center') pushWrapped(l.text, true);
    else if (l.type === 'text') pushWrapped(l.text, false);
    else if (l.type === 'hr') out.push('-'.repeat(cols));
    else if (l.type === 'gap') out.push('');
    else if (l.type === 'barcode') pushWrapped(l.text, true);
    else if (l.type === 'row') {
      const left = stripVietnamese(l.left);
      const right = stripVietnamese(l.right);
      const room = cols - right.length;
      if (left.length < room) out.push(left + ' '.repeat(room - left.length) + right);
      else {
        out.push(left.slice(0, cols));
        out.push(' '.repeat(Math.max(room, 0)) + right);
      }
    }
  }
  return `${out.join('\n')}\n`;
}
