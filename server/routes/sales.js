import { all, get, run, tx, nextCode, moveStock, addCashEntry, getSettings } from '../db.js';
import { HttpError, bad, conflict, notFound, now, dateRange, paging, round3, toMoney, toQty, toText, norm } from '../util.js';
import { METHODS } from './partners.js';

function loadInvoice(id, user) {
  const inv = get(
    `SELECT i.*, c.name AS customer_name, c.code AS customer_code, c.phone AS customer_phone, c.address AS customer_address, c.debt AS customer_debt,
            u.full_name AS user_name
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN users u ON u.id = i.user_id WHERE i.id = ?`,
    id,
  );
  if (!inv) throw notFound('Không tìm thấy hóa đơn');
  const out = {
    ...inv,
    items: all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', id).map((x) => ({ ...x })),
    returns: all('SELECT id, code, total, refund, debt_reduced, method, note, created_at FROM returns WHERE invoice_id = ? ORDER BY id', id),
  };
  if (user.role !== 'admin') {
    delete out.cost_total;
    out.items.forEach((x) => delete x.cost_price);
  }
  return out;
}

/** Máy chủ tự tính lại mọi số tiền; chỉ tin danh sách hàng, số lượng và số tiền khách đưa từ client. */
export function createInvoice(body, user, { createdAt = now() } = {}) {
  const settings = getSettings().business;
  if (!Array.isArray(body.items) || !body.items.length) throw bad('Hóa đơn chưa có hàng hóa');
  const clientRef = toText(body.client_ref, 64) || null;
  if (clientRef) {
    const dup = get('SELECT id FROM invoices WHERE client_ref = ?', clientRef);
    if (dup) return dup.id; // bấm thanh toán 2 lần hoặc mạng gửi lại: không tạo hóa đơn thứ hai
  }
  const method = METHODS.includes(body.method) ? body.method : 'cash';
  const customer = body.customer_id ? get('SELECT * FROM customers WHERE id = ? AND active = 1', body.customer_id) : null;
  if (body.customer_id && !customer) throw bad('Khách hàng không tồn tại');

  const lines = [];
  for (const item of body.items) {
    const product = get('SELECT * FROM products WHERE id = ? AND active = 1', item.product_id);
    if (!product) throw bad('Có hàng hóa không còn kinh doanh trong hóa đơn');
    const qty = toQty(item.qty, `Số lượng của "${product.name}"`);
    const price = item.price === undefined ? product.sale_price : toMoney(item.price, 'Đơn giá');
    if (price !== product.sale_price && user.role !== 'admin' && !settings.cashier_can_edit_price) {
      throw new HttpError(403, `Bạn không có quyền đổi giá bán của "${product.name}"`);
    }
    const gross = Math.round(qty * price);
    const discount = toMoney(item.discount, 'Giảm giá');
    if (discount > gross) throw bad(`Giảm giá của "${product.name}" lớn hơn thành tiền`);
    lines.push({ product, qty, price, discount, lineTotal: gross - discount });
  }

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const discount = toMoney(body.discount, 'Giảm giá hóa đơn');
  if (discount > subtotal) throw bad('Giảm giá lớn hơn tổng tiền hàng');
  const taxRate = Number(settings.tax_rate) || 0;
  const tax = Math.round(((subtotal - discount) * taxRate) / 100);
  const total = subtotal - discount + tax;
  const received = body.paid === undefined ? total : toMoney(body.paid, 'Tiền khách đưa');
  const paid = Math.min(received, total);
  const change = received - paid;
  const debt = total - paid;
  if (debt > 0 && !customer) throw bad('Bán nợ cần chọn khách hàng');
  if (change > 0 && method !== 'cash') throw bad('Chuyển khoản/thẻ không được lớn hơn số phải trả');

  const code = nextCode('HD');
  const { lastInsertRowid } = run(
    `INSERT INTO invoices (code, client_ref, customer_id, user_id, subtotal, discount, tax_rate, tax, total, paid, received, change_due, debt, method, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    code, clientRef, customer?.id ?? null, user.id, subtotal, discount, taxRate, tax, total, paid, received, change, debt, method, toText(body.note), createdAt,
  );
  const id = Number(lastInsertRowid);

  let costTotal = 0;
  for (const l of lines) {
    const cost = l.product.cost_price;
    costTotal += Math.round(l.qty * cost);
    run(
      `INSERT INTO invoice_items (invoice_id, product_id, code, name, unit, qty, price, discount, line_total, cost_price) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, l.product.id, l.product.code, l.product.name, l.product.unit, l.qty, l.price, l.discount, l.lineTotal, cost,
    );
    moveStock(l.product, -l.qty, 'sale', code, user.id, { check: !settings.allow_negative_stock, createdAt });
  }
  run('UPDATE invoices SET cost_total = ? WHERE id = ?', costTotal, id);

  if (customer) run('UPDATE customers SET debt = debt + ?, total_amount = total_amount + ? WHERE id = ?', debt, total, customer.id);
  if (paid > 0) {
    addCashEntry({
      type: 'in', method, category: 'Thu tiền bán hàng', amount: paid, source: 'sale', partnerType: customer ? 'customer' : null,
      partnerId: customer?.id ?? null, partnerName: customer?.name ?? 'Khách lẻ', refCode: code, userId: user.id, createdAt,
    });
  }
  return id;
}

function cancelInvoice(inv, user) {
  if (inv.status !== 'completed') throw conflict('Hóa đơn đã bị hủy trước đó');
  if (get('SELECT 1 AS x FROM returns WHERE invoice_id = ?', inv.id)) throw conflict('Hóa đơn đã có phiếu trả hàng, không thể hủy');
  if (get("SELECT 1 AS x FROM debt_allocations WHERE doc_type = 'invoice' AND doc_id = ?", inv.id)) {
    throw conflict('Hóa đơn đã được thu nợ. Hãy hủy phiếu thu nợ trong Sổ quỹ trước');
  }
  for (const item of all('SELECT * FROM invoice_items WHERE invoice_id = ?', inv.id)) {
    const product = get('SELECT * FROM products WHERE id = ?', item.product_id);
    moveStock(product, item.qty, 'sale_cancel', inv.code, user.id);
  }
  if (inv.customer_id) run('UPDATE customers SET debt = debt - ?, total_amount = total_amount - ? WHERE id = ?', inv.debt, inv.total, inv.customer_id);
  run("UPDATE cash_entries SET status = 'cancelled' WHERE ref_code = ? AND source = 'sale'", inv.code);
  run("UPDATE invoices SET status = 'cancelled', debt = 0, cancelled_at = ? WHERE id = ?", now(), inv.id);
}

/** Giá trị đã trừ chiết khấu của `qty` đơn vị trên một dòng. Tính lũy kế để trả nhiều lần không lệch làm tròn. */
function netFor(inv, item, qty) {
  const share = qty >= item.qty ? item.line_total : Math.round((item.line_total * qty) / item.qty);
  return Math.round(share * (1 - inv.discount / inv.subtotal));
}

function createReturn(inv, body, user) {
  if (inv.status !== 'completed') throw conflict('Hóa đơn đã bị hủy');
  if (!Array.isArray(body.items) || !body.items.length) throw bad('Chưa chọn hàng trả');
  const method = METHODS.includes(body.method) ? body.method : 'cash';
  const code = nextCode('TH');
  const createdAt = now();

  const lines = [];
  for (const row of body.items) {
    const item = get('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?', row.invoice_item_id, inv.id);
    if (!item) throw bad('Dòng hàng trả không thuộc hóa đơn này');
    const qty = toQty(row.qty, 'Số lượng trả');
    const after = round3(item.returned_qty + qty);
    if (after > item.qty) throw bad(`"${item.name}" chỉ còn được trả tối đa ${round3(item.qty - item.returned_qty)}`);
    lines.push({ item, qty, after, net: netFor(inv, item, after) - netFor(inv, item, item.returned_qty) });
  }

  let net = lines.reduce((s, l) => s + l.net, 0);
  const prev = get('SELECT COALESCE(SUM(net_amount),0) AS net, COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(total),0) AS total FROM returns WHERE invoice_id = ?', inv.id);
  let tax = Math.round((net * inv.tax_rate) / 100);
  const remaining = all('SELECT id, qty, returned_qty FROM invoice_items WHERE invoice_id = ?', inv.id).filter((it) => {
    const line = lines.find((l) => l.item.id === it.id);
    return round3(line ? line.after : it.returned_qty) < it.qty;
  });
  if (!remaining.length) {
    // Trả hết hóa đơn: lấy đúng phần còn lại để tổng tiền trả khớp tuyệt đối với hóa đơn.
    net = inv.subtotal - inv.discount - prev.net;
    tax = inv.tax - prev.tax;
  }
  const total = net + tax;
  const debtReduced = Math.min(inv.debt, total);
  const refund = total - debtReduced;
  let costTotal = 0;

  const { lastInsertRowid } = run(
    `INSERT INTO returns (code, invoice_id, customer_id, user_id, net_amount, tax, total, debt_reduced, refund, method, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    code, inv.id, inv.customer_id, user.id, net, tax, total, debtReduced, refund, method, toText(body.note), createdAt,
  );
  const returnId = Number(lastInsertRowid);

  for (const { item, qty, after, net: lineNet } of lines) {
    costTotal += Math.round(qty * item.cost_price);
    run('UPDATE invoice_items SET returned_qty = ? WHERE id = ?', after, item.id);
    run('INSERT INTO return_items (return_id, invoice_item_id, product_id, name, qty, amount, cost_price) VALUES (?,?,?,?,?,?,?)',
      returnId, item.id, item.product_id, item.name, qty, lineNet, item.cost_price);
    const product = get('SELECT * FROM products WHERE id = ?', item.product_id);
    if (product.track_stock) {
      // Hàng về kho theo giá vốn lúc bán, cập nhật lại giá vốn bình quân.
      const base = Math.max(product.stock, 0);
      const newCost = Math.round((base * product.cost_price + qty * item.cost_price) / (base + qty));
      run('UPDATE products SET cost_price = ? WHERE id = ?', newCost, product.id);
      moveStock(product, qty, 'return', code, user.id, { createdAt });
    }
  }
  run('UPDATE returns SET cost_total = ? WHERE id = ?', costTotal, returnId);
  run('UPDATE invoices SET debt = debt - ?, returned_total = returned_total + ? WHERE id = ?', debtReduced, total, inv.id);
  if (inv.customer_id) run('UPDATE customers SET debt = debt - ?, total_amount = total_amount - ? WHERE id = ?', debtReduced, total, inv.customer_id);
  if (refund > 0) {
    const customer = inv.customer_id ? get('SELECT name FROM customers WHERE id = ?', inv.customer_id) : null;
    addCashEntry({
      type: 'out', method, category: 'Trả tiền khách trả hàng', amount: refund, source: 'return', partnerType: inv.customer_id ? 'customer' : null,
      partnerId: inv.customer_id, partnerName: customer?.name ?? 'Khách lẻ', refCode: code, userId: user.id, createdAt,
    });
  }
  return { id: returnId, code, total, refund, debt_reduced: debtReduced };
}

export function register(r) {
  r.get('/api/invoices', ({ query, user }) => {
    const { start, end } = dateRange(query);
    const where = ['i.created_at >= ?', 'i.created_at < ?'];
    const args = [start, end];
    if (query.status) { where.push('i.status = ?'); args.push(query.status); }
    if (query.customer_id) { where.push('i.customer_id = ?'); args.push(Number(query.customer_id)); }
    if (query.q) {
      where.push("(i.code LIKE ? OR c.search_text LIKE ? ESCAPE '\\')");
      args.push(`%${toText(query.q, 40)}%`, `%${norm(query.q).replace(/[\\%_]/g, '\\$&')}%`);
    }
    const cond = where.join(' AND ');
    const { limit, offset } = paging(query);
    const summary = get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN i.status='completed' THEN i.total ELSE 0 END),0) AS total,
              COALESCE(SUM(CASE WHEN i.status='completed' THEN i.debt ELSE 0 END),0) AS debt
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE ${cond}`,
      ...args,
    );
    const rows = all(
      `SELECT i.id, i.code, i.total, i.paid, i.debt, i.method, i.status, i.returned_total, i.created_at,
              c.name AS customer_name, u.full_name AS user_name
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN users u ON u.id = i.user_id
       WHERE ${cond} ORDER BY i.id DESC LIMIT ? OFFSET ?`,
      ...args, limit, offset,
    );
    return { rows, total: summary.n, sum_total: summary.total, sum_debt: summary.debt };
  });

  r.get('/api/invoices/:id', ({ params, user }) => loadInvoice(params.id, user));

  r.post('/api/invoices', ({ body, user }) => loadInvoice(tx(() => createInvoice(body, user)), user));

  r.post('/api/invoices/:id/cancel', 'admin', ({ params, user }) => tx(() => {
    const inv = get('SELECT * FROM invoices WHERE id = ?', params.id);
    if (!inv) throw notFound('Không tìm thấy hóa đơn');
    cancelInvoice(inv, user);
    return loadInvoice(inv.id, user);
  }));

  r.post('/api/invoices/:id/returns', ({ params, body, user }) => tx(() => {
    const inv = get('SELECT * FROM invoices WHERE id = ?', params.id);
    if (!inv) throw notFound('Không tìm thấy hóa đơn');
    return createReturn(inv, body, user);
  }));

  r.get('/api/returns', ({ query }) => {
    const { start, end } = dateRange(query);
    const { limit, offset } = paging(query);
    const { n } = get('SELECT COUNT(*) AS n FROM returns WHERE created_at >= ? AND created_at < ?', start, end);
    const rows = all(
      `SELECT r.id, r.code, r.total, r.refund, r.debt_reduced, r.method, r.note, r.created_at, i.id AS invoice_id, i.code AS invoice_code,
              c.name AS customer_name, u.full_name AS user_name
       FROM returns r JOIN invoices i ON i.id = r.invoice_id LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN users u ON u.id = r.user_id
       WHERE r.created_at >= ? AND r.created_at < ? ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      start, end, limit, offset,
    );
    return { rows, total: n };
  });
}
