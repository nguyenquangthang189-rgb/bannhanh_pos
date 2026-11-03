import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { round3, now, conflict } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'bannhanh.db');
mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','cashier')),
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
DROP TABLE IF EXISTS secrets; -- khóa API của tính năng đọc ảnh bằng AI cũ, nay không dùng
CREATE TABLE IF NOT EXISTS counters (prefix TEXT PRIMARY KEY, n INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, barcode TEXT UNIQUE, name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id), unit TEXT NOT NULL DEFAULT 'cái',
  cost_price INTEGER NOT NULL DEFAULT 0, sale_price INTEGER NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0, min_stock REAL NOT NULL DEFAULT 0, track_stock INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1, search_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, phone TEXT, address TEXT, tax_code TEXT, note TEXT,
  debt INTEGER NOT NULL DEFAULT 0, total_amount INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, search_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, phone TEXT, address TEXT, tax_code TEXT, note TEXT,
  debt INTEGER NOT NULL DEFAULT 0, total_amount INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, search_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, client_ref TEXT UNIQUE,
  customer_id INTEGER REFERENCES customers(id), user_id INTEGER NOT NULL REFERENCES users(id),
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0, change_due INTEGER NOT NULL DEFAULT 0,
  debt INTEGER NOT NULL DEFAULT 0, returned_total INTEGER NOT NULL DEFAULT 0, cost_total INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'cash', status TEXT NOT NULL DEFAULT 'completed', note TEXT,
  created_at TEXT NOT NULL, cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, qty REAL NOT NULL, price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0, line_total INTEGER NOT NULL, cost_price INTEGER NOT NULL, returned_qty REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  customer_id INTEGER REFERENCES customers(id), user_id INTEGER NOT NULL REFERENCES users(id),
  net_amount INTEGER NOT NULL, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, debt_reduced INTEGER NOT NULL DEFAULT 0,
  refund INTEGER NOT NULL DEFAULT 0, cost_total INTEGER NOT NULL DEFAULT 0, method TEXT NOT NULL DEFAULT 'cash', note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_returns_created ON returns(created_at);
CREATE TABLE IF NOT EXISTS return_items (
  id INTEGER PRIMARY KEY, return_id INTEGER NOT NULL REFERENCES returns(id), invoice_item_id INTEGER NOT NULL REFERENCES invoice_items(id),
  product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, qty REAL NOT NULL, amount INTEGER NOT NULL, cost_price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, client_ref TEXT UNIQUE,
  supplier_id INTEGER REFERENCES suppliers(id), user_id INTEGER NOT NULL REFERENCES users(id),
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0, debt INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'cash', status TEXT NOT NULL DEFAULT 'completed', note TEXT, created_at TEXT NOT NULL, cancelled_at TEXT
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id), product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, qty REAL NOT NULL, cost INTEGER NOT NULL, line_total INTEGER NOT NULL,
  unit_net REAL NOT NULL, prev_cost INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), type TEXT NOT NULL, ref_code TEXT,
  qty REAL NOT NULL, stock_after REAL NOT NULL, cost_price INTEGER NOT NULL DEFAULT 0, user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_moves_product ON stock_moves(product_id, id);
CREATE TABLE IF NOT EXISTS stock_takes (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), note TEXT,
  diff_qty REAL NOT NULL DEFAULT 0, diff_value INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_take_items (
  id INTEGER PRIMARY KEY, stock_take_id INTEGER NOT NULL REFERENCES stock_takes(id), product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT NOT NULL, name TEXT NOT NULL, system_qty REAL NOT NULL, actual_qty REAL NOT NULL, diff_qty REAL NOT NULL, cost_price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_entries (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, type TEXT NOT NULL CHECK (type IN ('in','out')),
  method TEXT NOT NULL DEFAULT 'cash', category TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
  source TEXT NOT NULL DEFAULT 'manual', partner_type TEXT, partner_id INTEGER, partner_name TEXT, ref_code TEXT,
  in_pnl INTEGER NOT NULL DEFAULT 0, note TEXT, user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_created ON cash_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_cash_ref ON cash_entries(ref_code);
CREATE TABLE IF NOT EXISTS debt_allocations (
  id INTEGER PRIMARY KEY, cash_entry_id INTEGER NOT NULL REFERENCES cash_entries(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('invoice','purchase')), doc_id INTEGER NOT NULL, amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alloc_doc ON debt_allocations(doc_type, doc_id);
`);

/** node:sqlite đồng bộ nên mỗi request chạy trọn một giao dịch, không xen kẽ. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const get = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);

export function nextCode(prefix) {
  run('INSERT INTO counters (prefix, n) VALUES (?, 1) ON CONFLICT(prefix) DO UPDATE SET n = n + 1', prefix);
  const { n } = get('SELECT n FROM counters WHERE prefix = ?', prefix);
  return `${prefix}${String(n).padStart(6, '0')}`;
}

const DEFAULT_SETTINGS = {
  store: { name: 'Cửa hàng của tôi', address: '', phone: '', tax_code: '' },
  receipt: { title: 'HÓA ĐƠN BÁN HÀNG', footer: 'Cảm ơn quý khách. Hẹn gặp lại!', show_barcode: true },
  business: { tax_rate: 0, allow_negative_stock: false, cashier_can_edit_price: false },
};

export function getSettings() {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const row of all('SELECT key, value FROM settings')) {
    out[row.key] = { ...out[row.key], ...JSON.parse(row.value) };
  }
  return out;
}

export function saveSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

/**
 * Điểm duy nhất thay đổi tồn kho. Dịch vụ (track_stock = 0) không ghi thẻ kho.
 * `check` chặn bán âm kho khi cài đặt không cho phép.
 */
export function moveStock(product, delta, type, refCode, userId, { check = false, createdAt = now() } = {}) {
  if (!product.track_stock) return;
  const current = get('SELECT stock, cost_price FROM products WHERE id = ?', product.id);
  const after = round3(current.stock + delta);
  if (check && after < 0) throw conflict(`"${product.name}" không đủ tồn kho (còn ${current.stock})`);
  run('UPDATE products SET stock = ? WHERE id = ?', after, product.id);
  run(
    'INSERT INTO stock_moves (product_id, type, ref_code, qty, stock_after, cost_price, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
    product.id, type, refCode, delta, after, current.cost_price, userId, createdAt,
  );
}

export function addCashEntry({ type, method = 'cash', category, amount, source, partnerType = null, partnerId = null, partnerName = null, refCode = null, inPnl = 0, note = null, userId, createdAt = now() }) {
  const code = nextCode(type === 'in' ? 'PT' : 'PC');
  const { lastInsertRowid } = run(
    `INSERT INTO cash_entries (code, type, method, category, amount, source, partner_type, partner_id, partner_name, ref_code, in_pnl, note, user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    code, type, method, category, amount, source, partnerType, partnerId, partnerName, refCode, inPnl ? 1 : 0, note, userId, createdAt,
  );
  return { id: Number(lastInsertRowid), code };
}
