import { all, get, run, tx, nextCode, moveStock, addCashEntry, getSettings } from '../db.js';
import { bad, conflict, notFound, now, dateRange, paging, round3, toMoney, toQty, toText } from '../util.js';
import { METHODS } from './partners.js';

function loadPurchase(id) {
  const p = get(
    `SELECT p.*, s.name AS supplier_name, s.code AS supplier_code, u.full_name AS user_name
     FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    id,
  );
  if (!p) throw notFound('Không tìm thấy phiếu nhập');
  return { ...p, items: all('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id', id) };
}

/** Nhập hàng: tăng tồn và tính giá vốn bình quân gia quyền (đã phân bổ chiết khấu phiếu vào từng dòng). */
function createPurchase(body, user) {
  if (!Array.isArray(body.items) || !body.items.length) throw bad('Phiếu nhập chưa có hàng hóa');
  const clientRef = toText(body.client_ref, 64) || null;
  if (clientRef) {
    const dup = get('SELECT id FROM purchases WHERE client_ref = ?', clientRef);
    if (dup) return dup.id;
  }
  const method = METHODS.includes(body.method) ? body.method : 'cash';
  const supplier = body.supplier_id ? get('SELECT * FROM suppliers WHERE id = ? AND active = 1', body.supplier_id) : null;
  if (body.supplier_id && !supplier) throw bad('Nhà cung cấp không tồn tại');

  const lines = body.items.map((item) => {
    const product = get('SELECT * FROM products WHERE id = ? AND active = 1', item.product_id);
    if (!product) throw bad('Có hàng hóa không còn kinh doanh trong phiếu');
    if (!product.track_stock) throw bad(`"${product.name}" là dịch vụ, không nhập kho`);
    const qty = toQty(item.qty);
    const cost = toMoney(item.cost, 'Giá nhập');
    return { product, qty, cost, lineTotal: Math.round(qty * cost) };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const discount = toMoney(body.discount, 'Giảm giá');
  if (discount > subtotal) throw bad('Giảm giá lớn hơn tổng tiền hàng');
  const total = subtotal - discount;
  const paid = body.paid === undefined ? total : toMoney(body.paid, 'Tiền trả');
  if (paid > total) throw bad('Tiền trả lớn hơn số phải trả');
  const debt = total - paid;
  if (debt > 0 && !supplier) throw bad('Nhập nợ cần chọn nhà cung cấp');

  const code = nextCode('PN');
  const createdAt = now();
  const id = Number(run(
    `INSERT INTO purchases (code, client_ref, supplier_id, user_id, subtotal, discount, total, paid, debt, method, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    code, clientRef, supplier?.id ?? null, user.id, subtotal, discount, total, paid, debt, method, toText(body.note), createdAt,
  ).lastInsertRowid);

  for (const l of lines) {
    const fresh = get('SELECT * FROM products WHERE id = ?', l.product.id); // cùng hàng có thể xuất hiện 2 dòng
    const unitNet = subtotal ? (l.lineTotal * (1 - discount / subtotal)) / l.qty : 0;
    const base = Math.max(fresh.stock, 0);
    const newCost = Math.round((base * fresh.cost_price + l.qty * unitNet) / (base + l.qty));
    run(
      `INSERT INTO purchase_items (purchase_id, product_id, code, name, unit, qty, cost, line_total, unit_net, prev_cost) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, fresh.id, fresh.code, fresh.name, fresh.unit, l.qty, l.cost, l.lineTotal, unitNet, fresh.cost_price,
    );
    run('UPDATE products SET cost_price = ? WHERE id = ?', newCost, fresh.id);
    moveStock(fresh, l.qty, 'purchase', code, user.id, { createdAt });
  }
  if (supplier) run('UPDATE suppliers SET debt = debt + ?, total_amount = total_amount + ? WHERE id = ?', debt, total, supplier.id);
  if (paid > 0) {
    addCashEntry({
      type: 'out', method, category: 'Chi tiền nhập hàng', amount: paid, source: 'purchase', partnerType: supplier ? 'supplier' : null,
      partnerId: supplier?.id ?? null, partnerName: supplier?.name ?? null, refCode: code, userId: user.id, createdAt,
    });
  }
  return id;
}

function cancelPurchase(purchase, user) {
  if (purchase.status !== 'completed') throw conflict('Phiếu nhập đã bị hủy trước đó');
  if (get("SELECT 1 AS x FROM debt_allocations WHERE doc_type = 'purchase' AND doc_id = ?", purchase.id)) {
    throw conflict('Phiếu nhập đã trả nợ. Hãy hủy phiếu chi trả nợ trong Sổ quỹ trước');
  }
  const { allow_negative_stock: allowNegative } = getSettings().business;
  for (const item of all('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id DESC', purchase.id)) {
    const product = get('SELECT * FROM products WHERE id = ?', item.product_id);
    const left = round3(product.stock - item.qty);
    // Đảo công thức bình quân; hết hàng thì quay về giá vốn trước khi nhập.
    const restored = left > 0 ? Math.max(Math.round((product.stock * product.cost_price - item.qty * item.unit_net) / left), 0) : item.prev_cost;
    run('UPDATE products SET cost_price = ? WHERE id = ?', restored, product.id);
    moveStock(product, -item.qty, 'purchase_cancel', purchase.code, user.id, { check: !allowNegative });
  }
  if (purchase.supplier_id) run('UPDATE suppliers SET debt = debt - ?, total_amount = total_amount - ? WHERE id = ?', purchase.debt, purchase.total, purchase.supplier_id);
  run("UPDATE cash_entries SET status = 'cancelled' WHERE ref_code = ? AND source = 'purchase'", purchase.code);
  run("UPDATE purchases SET status = 'cancelled', debt = 0, cancelled_at = ? WHERE id = ?", now(), purchase.id);
}

/** Kiểm kho: đưa tồn hệ thống về số đếm thực tế; chênh lệch tính theo giá vốn hiện tại. */
function createStockTake(body, user) {
  if (!Array.isArray(body.items) || !body.items.length) throw bad('Phiếu kiểm kho chưa có hàng hóa');
  const code = nextCode('KK');
  const createdAt = now();
  const id = Number(run('INSERT INTO stock_takes (code, user_id, note, created_at) VALUES (?,?,?,?)', code, user.id, toText(body.note), createdAt).lastInsertRowid);
  let diffQty = 0;
  let diffValue = 0;
  for (const row of body.items) {
    const product = get('SELECT * FROM products WHERE id = ? AND active = 1', row.product_id);
    if (!product) throw bad('Có hàng hóa không còn kinh doanh trong phiếu');
    if (!product.track_stock) throw bad(`"${product.name}" là dịch vụ, không kiểm kho`);
    const actual = round3(Number(row.actual_qty));
    if (!Number.isFinite(actual) || actual < 0) throw bad(`Số thực tế của "${product.name}" không hợp lệ`);
    const diff = round3(actual - product.stock);
    run(
      'INSERT INTO stock_take_items (stock_take_id, product_id, code, name, system_qty, actual_qty, diff_qty, cost_price) VALUES (?,?,?,?,?,?,?,?)',
      id, product.id, product.code, product.name, product.stock, actual, diff, product.cost_price,
    );
    diffQty += diff;
    diffValue += Math.round(diff * product.cost_price);
    if (diff !== 0) moveStock(product, diff, 'stocktake', code, user.id, { createdAt });
  }
  run('UPDATE stock_takes SET diff_qty = ?, diff_value = ? WHERE id = ?', round3(diffQty), diffValue, id);
  return id;
}

export function register(r) {
  r.get('/api/purchases', 'admin', ({ query }) => {
    const { start, end } = dateRange(query);
    const { limit, offset } = paging(query);
    const { n } = get('SELECT COUNT(*) AS n FROM purchases WHERE created_at >= ? AND created_at < ?', start, end);
    const rows = all(
      `SELECT p.id, p.code, p.total, p.paid, p.debt, p.status, p.created_at, s.name AS supplier_name, u.full_name AS user_name
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN users u ON u.id = p.user_id
       WHERE p.created_at >= ? AND p.created_at < ? ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      start, end, limit, offset,
    );
    return { rows, total: n };
  });
  r.get('/api/purchases/:id', 'admin', ({ params }) => loadPurchase(params.id));
  r.post('/api/purchases', 'admin', ({ body, user }) => loadPurchase(tx(() => createPurchase(body, user))));
  r.post('/api/purchases/:id/cancel', 'admin', ({ params, user }) => tx(() => {
    const p = get('SELECT * FROM purchases WHERE id = ?', params.id);
    if (!p) throw notFound('Không tìm thấy phiếu nhập');
    cancelPurchase(p, user);
    return loadPurchase(p.id);
  }));

  r.get('/api/stocktakes', 'admin', ({ query }) => {
    const { limit, offset } = paging(query);
    const { n } = get('SELECT COUNT(*) AS n FROM stock_takes');
    const rows = all(
      `SELECT t.*, u.full_name AS user_name FROM stock_takes t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      limit, offset,
    );
    return { rows, total: n };
  });
  r.get('/api/stocktakes/:id', 'admin', ({ params }) => {
    const t = get('SELECT t.*, u.full_name AS user_name FROM stock_takes t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?', params.id);
    if (!t) throw notFound('Không tìm thấy phiếu kiểm kho');
    return { ...t, items: all('SELECT * FROM stock_take_items WHERE stock_take_id = ? ORDER BY id', t.id) };
  });
  r.post('/api/stocktakes', 'admin', ({ body, user }) => ({ id: tx(() => createStockTake(body, user)) }));
}

export { createPurchase };
