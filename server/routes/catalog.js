import { all, get, run, tx, nextCode, moveStock } from '../db.js';
import { bad, conflict, notFound, now, norm, likeParam, paging, required, toMoney, toText, round3 } from '../util.js';

function publicProduct(p, user) {
  const out = { ...p };
  delete out.search_text;
  if (user.role !== 'admin') delete out.cost_price;
  return out;
}

function categoryId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!get('SELECT 1 AS x FROM categories WHERE id = ?', id)) throw bad('Nhóm hàng không tồn tại');
  return id;
}

function ensureCategory(name) {
  const clean = toText(name, 100);
  if (!clean) return null;
  const row = get('SELECT id FROM categories WHERE name = ?', clean);
  return row ? row.id : Number(run('INSERT INTO categories (name) VALUES (?)', clean).lastInsertRowid);
}

function assertUnique(code, barcode, exceptId = 0) {
  if (get('SELECT 1 AS x FROM products WHERE code = ? AND id <> ?', code, exceptId)) throw conflict(`Mã hàng "${code}" đã tồn tại`);
  if (barcode && get('SELECT 1 AS x FROM products WHERE barcode = ? AND id <> ?', barcode, exceptId)) throw conflict(`Mã vạch "${barcode}" đã được dùng cho hàng hóa khác`);
}

/** Tạo hàng hóa; tồn đầu kỳ được ghi vào thẻ kho. Sau đó tồn chỉ đổi qua bán, nhập, trả, kiểm kho. */
export function createProduct(data, userId) {
  const name = required(data.name, 'tên hàng');
  const code = toText(data.code, 40) || nextCode('SP');
  const barcode = toText(data.barcode, 64) || null;
  assertUnique(code, barcode);
  const track = data.track_stock === undefined ? 1 : (data.track_stock ? 1 : 0);
  const stock = track ? round3(Number(data.stock ?? 0)) : 0;
  if (!Number.isFinite(stock) || stock < 0) throw bad('Tồn kho không hợp lệ');
  const minStock = round3(Number(data.min_stock ?? 0));
  if (!Number.isFinite(minStock) || minStock < 0) throw bad('Tồn tối thiểu không hợp lệ');
  const { lastInsertRowid } = run(
    `INSERT INTO products (code, barcode, name, category_id, unit, cost_price, sale_price, stock, min_stock, track_stock, search_text, created_at)
     VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`,
    code, barcode, name, categoryId(data.category_id), toText(data.unit, 20) || 'cái',
    toMoney(data.cost_price, 'Giá vốn'), toMoney(data.sale_price, 'Giá bán'), minStock, track,
    norm(`${code} ${barcode ?? ''} ${name}`), now(),
  );
  const id = Number(lastInsertRowid);
  if (stock > 0) moveStock({ id, name, track_stock: track }, stock, 'opening', code, userId);
  return id;
}

function updateProduct(p, data) {
  const name = required(data.name ?? p.name, 'tên hàng');
  const code = toText(data.code ?? p.code, 40) || p.code;
  const barcode = data.barcode === undefined ? p.barcode : (toText(data.barcode, 64) || null);
  assertUnique(code, barcode, p.id);
  const minStock = data.min_stock === undefined ? p.min_stock : round3(Number(data.min_stock));
  if (!Number.isFinite(minStock) || minStock < 0) throw bad('Tồn tối thiểu không hợp lệ');
  run(
    `UPDATE products SET code=?, barcode=?, name=?, category_id=?, unit=?, cost_price=?, sale_price=?, min_stock=?, search_text=?, active=? WHERE id=?`,
    code, barcode, name, data.category_id === undefined ? p.category_id : categoryId(data.category_id),
    toText(data.unit ?? p.unit, 20) || 'cái',
    data.cost_price === undefined ? p.cost_price : toMoney(data.cost_price, 'Giá vốn'),
    data.sale_price === undefined ? p.sale_price : toMoney(data.sale_price, 'Giá bán'),
    minStock, norm(`${code} ${barcode ?? ''} ${name}`),
    data.active === undefined ? p.active : (data.active ? 1 : 0), p.id,
  );
}

export function register(r) {
  r.get('/api/categories', () => all('SELECT c.id, c.name, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count FROM categories c ORDER BY c.name'));
  r.post('/api/categories', 'admin', ({ body }) => {
    const name = required(body.name, 'tên nhóm');
    if (get('SELECT 1 AS x FROM categories WHERE name = ?', name)) throw conflict('Nhóm hàng đã tồn tại');
    return { id: Number(run('INSERT INTO categories (name) VALUES (?)', name).lastInsertRowid), name };
  });
  r.delete('/api/categories/:id', 'admin', ({ params }) => tx(() => {
    run('UPDATE products SET category_id = NULL WHERE category_id = ?', params.id);
    run('DELETE FROM categories WHERE id = ?', params.id);
    return { ok: true };
  }));

  r.get('/api/products', ({ query, user }) => {
    const where = ['p.active = ?'];
    const args = [query.active === '0' ? 0 : 1];
    if (query.q) { where.push("p.search_text LIKE ? ESCAPE '\\'"); args.push(likeParam(query.q)); }
    if (query.category_id) { where.push('p.category_id = ?'); args.push(Number(query.category_id)); }
    if (query.low === '1') where.push('p.track_stock = 1 AND p.stock <= p.min_stock');
    const cond = where.join(' AND ');
    const { limit, offset } = paging(query);
    const { n } = get(`SELECT COUNT(*) AS n FROM products p WHERE ${cond}`, ...args);
    const rows = all(
      `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${cond} ORDER BY p.name COLLATE NOCASE LIMIT ? OFFSET ?`,
      ...args, limit, offset,
    );
    return { rows: rows.map((p) => publicProduct(p, user)), total: n };
  });

  // Máy quét gửi mã về đây: ưu tiên khớp mã vạch, sau đó tới mã hàng.
  r.get('/api/products/lookup', ({ query, user }) => {
    const code = toText(query.code, 64);
    const p = get(
      `SELECT * FROM products WHERE active = 1 AND (barcode = ? OR code = ? COLLATE NOCASE)
       ORDER BY CASE WHEN barcode = ? THEN 0 ELSE 1 END LIMIT 1`,
      code, code, code,
    );
    if (!p) throw notFound(`Không tìm thấy hàng có mã "${code}"`);
    return publicProduct(p, user);
  });

  r.post('/api/products', 'admin', ({ body, user }) => tx(() => {
    const id = createProduct(body, user.id);
    return publicProduct(get('SELECT * FROM products WHERE id = ?', id), user);
  }));

  // Nhập theo lô từ CSV: mã đã có thì cập nhật thông tin (không đổi tồn), mã mới thì tạo cùng tồn đầu kỳ.
  r.post('/api/products/import', 'admin', ({ body, user }) => tx(() => {
    if (!Array.isArray(body.rows) || !body.rows.length) throw bad('File không có dòng dữ liệu');
    let created = 0;
    let updated = 0;
    body.rows.forEach((row, i) => {
      try {
        const data = { ...row, category_id: ensureCategory(row.category) };
        const existing = row.code ? get('SELECT * FROM products WHERE code = ?', toText(row.code, 40)) : null;
        if (existing) {
          updateProduct(existing, { ...data, active: 1 });
          updated += 1;
        } else {
          createProduct(data, user.id);
          created += 1;
        }
      } catch (err) {
        err.message = `Dòng ${i + 2}: ${err.message}`;
        throw err;
      }
    });
    return { created, updated };
  }));

  r.put('/api/products/:id', 'admin', ({ params, body, user }) => tx(() => {
    const p = get('SELECT * FROM products WHERE id = ?', params.id);
    if (!p) throw notFound();
    updateProduct(p, body);
    return publicProduct(get('SELECT * FROM products WHERE id = ?', p.id), user);
  }));

  // Ngừng kinh doanh thay vì xóa cứng, để hóa đơn cũ vẫn tra được.
  r.delete('/api/products/:id', 'admin', ({ params }) => {
    run('UPDATE products SET active = 0 WHERE id = ?', params.id);
    return { ok: true };
  });

  r.get('/api/products/:id/moves', 'admin', ({ params, query }) => {
    const { limit, offset } = paging(query, 100);
    return all(
      `SELECT m.*, u.full_name AS user_name FROM stock_moves m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.product_id = ? ORDER BY m.id DESC LIMIT ? OFFSET ?`,
      params.id, limit, offset,
    );
  });
}
