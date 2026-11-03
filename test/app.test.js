import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'bannhanh-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.BN_SHORTCUT_DIR = dir; // không đụng tới Desktop thật khi kiểm thử

const { createAppServer } = await import('../server/app.js');
const { db } = await import('../server/db.js');
const { CODE128_PATTERNS, code128Modules } = await import('../public/js/devices/barcode.js');
const escpos = await import('../public/js/devices/escpos.js');

let server;
let base;
const adminJar = { cookie: '' };
const cashierJar = { cookie: '' };

async function call(jar, method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(jar?.cookie ? { Cookie: jar.cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && jar) jar.cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const admin = (m, u, b) => call(adminJar, m, u, b);
const cashier = (m, u, b) => call(cashierJar, m, u, b);
async function ok(promise) {
  const r = await promise;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const product = async (id) => (await ok(admin('GET', '/api/products?limit=1000'))).rows.find((p) => p.id === id);
const customer = async (id) => (await ok(admin('GET', '/api/customers?limit=1000'))).rows.find((c) => c.id === id);
const supplier = async (id) => (await ok(admin('GET', '/api/suppliers?limit=1000'))).rows.find((c) => c.id === id);
const cash = async () => (await ok(admin('GET', '/api/reports/eod'))).cash_closing;

let A; let B; let cust; let supp;

before(async () => {
  server = createAppServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('thiết lập lần đầu tạo chủ cửa hàng và khóa setup về sau', async () => {
  assert.equal((await call(null, 'GET', '/api/auth/state')).data.needsSetup, true);
  await ok(call(adminJar, 'POST', '/api/auth/setup', { store_name: 'Shop', full_name: 'Chủ', username: 'owner', password: 'matkhau1' }));
  const again = await call(null, 'POST', '/api/auth/setup', { store_name: 'X', full_name: 'X', username: 'evil', password: 'matkhau1' });
  assert.equal(again.status, 403);
  assert.equal((await call(null, 'GET', '/api/products')).status, 401);
});

test('đăng nhập sai bị khóa tạm thời; thu ngân bị giới hạn quyền', async () => {
  await ok(admin('POST', '/api/users', { username: 'thungan', full_name: 'Thu Ngân', password: 'matkhau2', role: 'cashier' }));
  await ok(call(cashierJar, 'POST', '/api/auth/login', { username: 'thungan', password: 'matkhau2' }));
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call(null, 'POST', '/api/auth/login', { username: 'owner', password: 'sai' })).status, 401);
  }
  assert.equal((await call(null, 'POST', '/api/auth/login', { username: 'owner', password: 'matkhau1' })).status, 429);
  for (const url of ['/api/cashbook', '/api/purchases', '/api/reports/profit', '/api/users', '/api/backup']) {
    assert.equal((await cashier('GET', url)).status, 403, url);
  }
});

test('chặn request ghi dữ liệu từ nguồn khác', async () => {
  const r = await call(adminJar, 'POST', '/api/categories', { name: 'X' }, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('tạo hàng hóa; tìm không dấu; tra mã vạch; thu ngân không thấy giá vốn', async () => {
  A = (await ok(admin('POST', '/api/products', { name: 'Áo thun đỏ', barcode: '8930001', cost_price: 60000, sale_price: 100000, stock: 10 }))).id;
  B = (await ok(admin('POST', '/api/products', { name: 'Đường cát', code: 'DUONG', unit: 'kg', cost_price: 20000, sale_price: 30000, stock: 5 }))).id;
  const dup = await admin('POST', '/api/products', { name: 'Trùng', barcode: '8930001' });
  assert.equal(dup.status, 409);
  const found = await ok(cashier('GET', '/api/products?q=ao%20thun'));
  assert.equal(found.rows[0].id, A);
  assert.equal(found.rows[0].cost_price, undefined);
  assert.equal((await ok(cashier('GET', '/api/products/lookup?code=8930001'))).id, A);
  assert.equal((await ok(cashier('GET', '/api/products/lookup?code=duong'))).id, B);
  assert.equal((await cashier('GET', '/api/products/lookup?code=khongco')).status, 404);
  cust = (await ok(cashier('POST', '/api/customers', { name: 'Chị Lan', phone: '0901' }))).id;
  supp = (await ok(admin('POST', '/api/suppliers', { name: 'NCC Một' }))).id;
});

test('bán hàng: tiền thừa, tồn kho, sổ quỹ, chống gửi trùng, chống đổi giá', async () => {
  const before0 = await cash();
  const inv = await ok(cashier('POST', '/api/invoices', {
    client_ref: 'ref-1', items: [{ product_id: A, qty: 2 }, { product_id: B, qty: 1.5 }], discount: 5000, paid: 300000,
  }));
  assert.equal(inv.subtotal, 245000);
  assert.equal(inv.total, 240000);
  assert.equal(inv.paid, 240000);
  assert.equal(inv.change_due, 60000);
  assert.equal(inv.debt, 0);
  assert.equal((await product(A)).stock, 8);
  assert.equal((await product(B)).stock, 3.5);
  assert.equal(await cash(), before0 + 240000);

  const dup = await ok(cashier('POST', '/api/invoices', { client_ref: 'ref-1', items: [{ product_id: A, qty: 2 }] }));
  assert.equal(dup.id, inv.id);
  assert.equal((await product(A)).stock, 8);

  assert.equal((await cashier('POST', '/api/invoices', { items: [{ product_id: A, qty: 1, price: 1000 }] })).status, 403);
  assert.equal((await cashier('POST', '/api/invoices', { items: [{ product_id: A, qty: 999 }] })).status, 409);
  assert.equal((await product(A)).stock, 8, 'giao dịch lỗi phải rollback');
  assert.equal((await cashier('POST', '/api/invoices', { items: [{ product_id: A, qty: 1 }], paid: 10 })).status, 400, 'bán nợ cần khách');
  assert.equal((await cashier('POST', '/api/invoices', { items: [{ product_id: A, qty: -1 }] })).status, 400);
});

test('bán nợ, thu nợ FIFO, hủy phiếu thu nợ khôi phục công nợ', async () => {
  const i1 = await ok(cashier('POST', '/api/invoices', { customer_id: cust, items: [{ product_id: A, qty: 1 }], paid: 40000 }));
  const i2 = await ok(cashier('POST', '/api/invoices', { customer_id: cust, items: [{ product_id: A, qty: 1 }], paid: 0 }));
  assert.equal(i1.debt, 60000);
  assert.equal((await customer(cust)).debt, 160000);

  assert.equal((await cashier('POST', `/api/customers/${cust}/pay`, { amount: 999999 })).status, 400);
  const before0 = await cash();
  const pay = await ok(cashier('POST', `/api/customers/${cust}/pay`, { amount: 80000 }));
  assert.equal(pay.debt, 80000);
  assert.equal(await cash(), before0 + 80000);
  assert.equal((await ok(admin('GET', `/api/invoices/${i1.id}`))).debt, 0);
  assert.equal((await ok(admin('GET', `/api/invoices/${i2.id}`))).debt, 80000);

  assert.equal((await admin('POST', `/api/invoices/${i2.id}/cancel`)).status, 409, 'đã thu nợ thì không hủy được');
  await ok(admin('POST', `/api/cashbook/${pay.id}/cancel`));
  assert.equal((await customer(cust)).debt, 160000);
  assert.equal((await ok(admin('GET', `/api/invoices/${i1.id}`))).debt, 60000);
  assert.equal(await cash(), before0);

  const stock = (await product(A)).stock;
  await ok(admin('POST', `/api/invoices/${i2.id}/cancel`));
  assert.equal((await product(A)).stock, stock + 1);
  assert.equal((await customer(cust)).debt, 60000);
  assert.equal((await admin('POST', `/api/invoices/${i2.id}/cancel`)).status, 409);
  assert.equal((await cashier('POST', `/api/invoices/${i1.id}/cancel`)).status, 403);
});

test('trả hàng từng phần: phân bổ chiết khấu, trừ nợ trước, tổng khớp đúng hóa đơn', async () => {
  // 3 cái * 100.000 - giảm 10.000 = 290.000; trả làm 3 lần không được lệch làm tròn.
  const inv = await ok(cashier('POST', '/api/invoices', { items: [{ product_id: A, qty: 3 }], discount: 10000 }));
  const itemId = inv.items[0].id;
  const startStock = (await product(A)).stock;
  const r1 = await ok(cashier('POST', `/api/invoices/${inv.id}/returns`, { items: [{ invoice_item_id: itemId, qty: 1 }] }));
  const r2 = await ok(cashier('POST', `/api/invoices/${inv.id}/returns`, { items: [{ invoice_item_id: itemId, qty: 1 }] }));
  assert.equal((await cashier('POST', `/api/invoices/${inv.id}/returns`, { items: [{ invoice_item_id: itemId, qty: 2 }] })).status, 400);
  const r3 = await ok(cashier('POST', `/api/invoices/${inv.id}/returns`, { items: [{ invoice_item_id: itemId, qty: 1 }] }));
  assert.equal(r1.total + r2.total + r3.total, 290000);
  assert.equal((await product(A)).stock, startStock + 3);
  assert.equal((await admin('POST', `/api/invoices/${inv.id}/cancel`)).status, 409);

  const debtBefore = (await customer(cust)).debt;
  const credit = await ok(cashier('POST', '/api/invoices', { customer_id: cust, items: [{ product_id: A, qty: 2 }], paid: 150000 }));
  const r = await ok(cashier('POST', `/api/invoices/${credit.id}/returns`, { items: [{ invoice_item_id: credit.items[0].id, qty: 1 }] }));
  assert.equal(r.debt_reduced, 50000);
  assert.equal(r.refund, 50000);
  assert.equal((await customer(cust)).debt, debtBefore);
});

test('nhập hàng: giá vốn bình quân, công nợ NCC, hủy phiếu đảo lại', async () => {
  const p0 = await product(B); // tồn 3.5, vốn 20.000
  const pu = await ok(admin('POST', '/api/purchases', {
    supplier_id: supp, items: [{ product_id: B, qty: 10, cost: 26000 }], discount: 10000, paid: 100000,
  }));
  assert.equal(pu.total, 250000);
  assert.equal(pu.debt, 150000);
  const p1 = await product(B);
  assert.equal(p1.stock, 13.5);
  // (3.5*20000 + 10*25000) / 13.5
  assert.equal(p1.cost_price, Math.round((3.5 * 20000 + 10 * 25000) / 13.5));
  assert.equal((await supplier(supp)).debt, 150000);

  await ok(admin('POST', `/api/purchases/${pu.id}/cancel`));
  const p2 = await product(B);
  assert.equal(p2.stock, p0.stock);
  assert.ok(Math.abs(p2.cost_price - p0.cost_price) <= 1, `giá vốn ${p2.cost_price}`);
  assert.equal((await supplier(supp)).debt, 0);
});

test('kiểm kho ghi chênh lệch và thẻ kho khớp tồn', async () => {
  const p = await product(B);
  const { id } = await ok(admin('POST', '/api/stocktakes', { items: [{ product_id: B, actual_qty: p.stock - 1 }] }));
  const t = await ok(admin('GET', `/api/stocktakes/${id}`));
  assert.equal(t.diff_value, -p.cost_price);
  assert.equal((await product(B)).stock, p.stock - 1);
  const moves = await ok(admin('GET', `/api/products/${B}/moves`));
  assert.equal(moves[0].stock_after, p.stock - 1);
  const sum = moves.reduce((s, m) => s + m.qty, 0);
  assert.ok(Math.abs(sum - (p.stock - 1)) < 1e-6, 'tổng thẻ kho phải bằng tồn');
});

test('sổ quỹ và báo cáo đối chiếu được với chứng từ', async () => {
  const before0 = await ok(admin('GET', '/api/reports/profit'));
  await ok(admin('POST', '/api/cashbook', { type: 'out', category: 'Tiền lương', amount: 500000, in_pnl: true }));
  await ok(admin('POST', '/api/cashbook', { type: 'in', category: 'Góp vốn', amount: 900000, in_pnl: false }));
  const r = await ok(admin('GET', '/api/reports/profit'));
  assert.equal(r.other_expense - before0.other_expense, 500000);
  assert.equal(r.other_income, before0.other_income, 'góp vốn không tính vào lãi lỗ');
  assert.equal(r.net_profit, r.gross_profit + r.other_income - r.other_expense + r.stock_diff);

  // Đối chiếu với dữ liệu thô: doanh thu thuần = hóa đơn còn hiệu lực - hàng trả.
  const raw = db.prepare("SELECT SUM(subtotal - discount) AS v FROM invoices WHERE status = 'completed'").get().v;
  const ret = db.prepare('SELECT SUM(net_amount) AS v FROM returns').get().v;
  assert.equal(r.revenue, raw - ret);

  // Công nợ tổng hợp phải bằng tổng công nợ từng chứng từ.
  for (const [table, doc, fk] of [['customers', 'invoices', 'customer_id'], ['suppliers', 'purchases', 'supplier_id']]) {
    const partner = db.prepare(`SELECT COALESCE(SUM(debt),0) AS v FROM ${table}`).get().v;
    const docs = db.prepare(`SELECT COALESCE(SUM(debt),0) AS v FROM ${doc} WHERE status='completed' AND ${fk} IS NOT NULL`).get().v;
    assert.equal(partner, docs, table);
  }

  // Sổ quỹ khớp: mọi tiền vào từ bán hàng bằng phần đã thanh toán lúc bán.
  const book = await ok(admin('GET', '/api/cashbook?limit=1000'));
  assert.equal(book.summary.closing, book.summary.opening + book.summary.total_in - book.summary.total_out);
  assert.equal(book.summary.closing, await cash());

  const dash = await ok(admin('GET', '/api/reports/dashboard'));
  assert.equal(dash.chart.length, 30);
  assert.equal(dash.chart.at(-1).revenue, r.revenue);
});

test('in mạng: gửi đúng byte tới máy in giả; chặn địa chỉ ngoài LAN', async () => {
  const received = [];
  const printer = net.createServer((s) => s.on('data', (d) => received.push(d)));
  await new Promise((r) => printer.listen(0, '127.0.0.1', r));
  const data = Buffer.from([0x1b, 0x40, 0x41, 0x42]).toString('base64');
  await ok(cashier('POST', '/api/print/raw', { transport: 'network', host: '127.0.0.1', port: printer.address().port, data }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([...Buffer.concat(received)], [0x1b, 0x40, 0x41, 0x42]);
  printer.close();
  assert.equal((await cashier('POST', '/api/print/raw', { transport: 'network', host: '8.8.8.8', data })).status, 400);
  assert.equal((await cashier('POST', '/api/print/raw', { transport: 'network', host: 'evil.example', data })).status, 400);
  assert.equal((await cashier('POST', '/api/print/raw', { transport: 'network', host: '127.0.0.1', port: 1, data })).status, 502);
  assert.equal((await cashier('POST', '/api/print/raw', { transport: 'windows', printer: 'Khong ton tai', data })).status, 400);
});

test('tạo shortcut: chỉ quản trị viên; trỏ đúng start.bat và biểu tượng', { skip: process.platform !== 'win32' }, async () => {
  assert.equal((await cashier('POST', '/api/system/shortcut')).status, 403);
  const { paths } = await ok(admin('POST', '/api/system/shortcut'));
  assert.deepEqual(paths, [path.join(dir, 'BanNhanh.lnk')]);
  const script = `$l=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); ConvertTo-Json @{t=$l.TargetPath;w=$l.WorkingDirectory;i=$l.IconLocation;s=$l.WindowStyle} -Compress`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, LNK: paths[0] }, encoding: 'utf8' });
  const link = JSON.parse(out);
  const root = path.resolve(import.meta.dirname, '..');
  assert.equal(link.t, path.join(root, 'start.bat'));
  assert.equal(link.w, root);
  assert.equal(link.i, `${path.join(root, 'public', 'icon.ico')},0`);
  assert.equal(link.s, 7);
});

test('Code 128: bảng mẫu đúng độ rộng và checksum chuẩn', () => {
  assert.equal(CODE128_PATTERNS.length, 107);
  assert.equal(new Set(CODE128_PATTERNS).size, 107);
  CODE128_PATTERNS.slice(0, 106).forEach((p) => {
    assert.equal([...p].reduce((s, c) => s + Number(c), 0), 11, p);
  });
  assert.equal([...CODE128_PATTERNS[106]].reduce((s, c) => s + Number(c), 0), 13);
  // "HD1": start B(104) + 40*1 + 36*2 + 17*3 = 267; 267 % 103 = 61
  const modules = code128Modules('HD1');
  assert.equal(modules.length, 11 * 5 + 13);
  const toWidths = (arr) => {
    const out = [];
    let run = 1;
    for (let i = 1; i <= arr.length; i += 1) {
      if (arr[i] === arr[i - 1]) run += 1;
      else { out.push(run); run = 1; }
    }
    return out.join('');
  };
  assert.equal(toWidths(modules.slice(44, 55)), CODE128_PATTERNS[61]);
  assert.throws(() => code128Modules('Áo'));
});

test('ESC/POS: ảnh raster đúng header, chia dải; chế độ chữ bỏ dấu', () => {
  const width = 16;
  const height = 300;
  const bits = new Uint8Array(width * height);
  bits[0] = 1;
  bits[width * 255 + 15] = 1;
  const out = escpos.raster(bits, width, height);
  assert.deepEqual([...out.slice(0, 8)], [0x1d, 0x76, 0x30, 0, 2, 0, 255, 0]);
  assert.equal(out[8], 0x80);
  const secondBand = 8 + 2 * 255;
  assert.deepEqual([...out.slice(secondBand, secondBand + 8)], [0x1d, 0x76, 0x30, 0, 2, 0, 45, 0]);
  assert.equal(out[secondBand + 8 + 1], 0x01);
  assert.equal(escpos.stripVietnamese('Đường Ăn ệ'), 'Duong An e');
});

test('dữ liệu mẫu chạy qua nghiệp vụ thật và khớp tồn kho', async () => {
  const { seedDemo } = await import('../server/seed.js');
  const owner = db.prepare("SELECT id FROM users WHERE username='owner'").get().id;
  seedDemo(owner);
  const bad = db.prepare(`SELECT p.id, p.stock, (SELECT SUM(qty) FROM stock_moves m WHERE m.product_id = p.id) AS moved
    FROM products p WHERE p.track_stock = 1 AND ABS(p.stock - COALESCE((SELECT SUM(qty) FROM stock_moves m WHERE m.product_id = p.id),0)) > 0.0001`).all();
  assert.deepEqual(bad, []);
});
