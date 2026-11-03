import { all, get, run, tx, nextCode, addCashEntry } from '../db.js';
import { bad, conflict, notFound, now, norm, likeParam, paging, required, toMoney, toText } from '../util.js';

export const METHODS = ['cash', 'bank', 'card'];

const KINDS = {
  customers: {
    prefix: 'KH', partnerType: 'customer', access: 'user', docTable: 'invoices', docType: 'invoice', docFk: 'customer_id',
    entryType: 'in', category: 'Thu nợ khách hàng',
  },
  suppliers: {
    prefix: 'NCC', partnerType: 'supplier', access: 'admin', docTable: 'purchases', docType: 'purchase', docFk: 'supplier_id',
    entryType: 'out', category: 'Trả nợ nhà cung cấp',
  },
};

export function createPartner(table, data) {
  const kind = KINDS[table];
  const name = required(data.name, 'tên');
  const code = toText(data.code, 40) || nextCode(kind.prefix);
  if (get(`SELECT 1 AS x FROM ${table} WHERE code = ?`, code)) throw conflict(`Mã "${code}" đã tồn tại`);
  const phone = toText(data.phone, 20);
  const { lastInsertRowid } = run(
    `INSERT INTO ${table} (code, name, phone, address, tax_code, note, search_text, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    code, name, phone, toText(data.address), toText(data.tax_code, 20), toText(data.note), norm(`${code} ${name} ${phone}`), now(),
  );
  return Number(lastInsertRowid);
}

/** Phân bổ tiền trả nợ vào chứng từ cũ nhất trước (FIFO) và ghi lại để có thể hoàn tác khi hủy phiếu. */
function settleDebt(table, partner, amount, method, note, userId) {
  const kind = KINDS[table];
  if (amount <= 0) throw bad('Số tiền phải lớn hơn 0');
  if (amount > partner.debt) throw bad(`Số tiền vượt quá công nợ hiện tại (${partner.debt.toLocaleString('vi-VN')} đ)`);
  const entry = addCashEntry({
    type: kind.entryType, method, category: kind.category, amount, source: 'debt',
    partnerType: kind.partnerType, partnerId: partner.id, partnerName: partner.name, note, userId,
  });
  let left = amount;
  const docs = all(`SELECT id, debt FROM ${kind.docTable} WHERE ${kind.docFk} = ? AND debt > 0 AND status = 'completed' ORDER BY id`, partner.id);
  for (const doc of docs) {
    if (!left) break;
    const part = Math.min(left, doc.debt);
    run(`UPDATE ${kind.docTable} SET debt = debt - ?, paid = paid + ? WHERE id = ?`, part, part, doc.id);
    run('INSERT INTO debt_allocations (cash_entry_id, doc_type, doc_id, amount) VALUES (?,?,?,?)', entry.id, kind.docType, doc.id, part);
    left -= part;
  }
  run(`UPDATE ${table} SET debt = debt - ? WHERE id = ?`, amount, partner.id);
  return entry;
}

/** Hoàn tác phiếu thu/chi nợ: trả công nợ về đúng các chứng từ đã phân bổ. */
export function reverseDebtEntry(entry) {
  const table = entry.partner_type === 'customer' ? 'customers' : 'suppliers';
  const kind = KINDS[table];
  for (const a of all('SELECT * FROM debt_allocations WHERE cash_entry_id = ?', entry.id)) {
    run(`UPDATE ${kind.docTable} SET debt = debt + ?, paid = paid - ? WHERE id = ?`, a.amount, a.amount, a.doc_id);
  }
  run('DELETE FROM debt_allocations WHERE cash_entry_id = ?', entry.id);
  run(`UPDATE ${table} SET debt = debt + ? WHERE id = ?`, entry.amount, entry.partner_id);
}

export function register(r) {
  for (const [table, kind] of Object.entries(KINDS)) {
    r.get(`/api/${table}`, kind.access, ({ query }) => {
      const where = ['active = 1'];
      const args = [];
      if (query.q) { where.push("search_text LIKE ? ESCAPE '\\'"); args.push(likeParam(query.q)); }
      if (query.debt === '1') where.push('debt > 0');
      const cond = where.join(' AND ');
      const { limit, offset } = paging(query);
      const { n, debt } = get(`SELECT COUNT(*) AS n, COALESCE(SUM(debt), 0) AS debt FROM ${table} WHERE ${cond}`, ...args);
      const rows = all(`SELECT * FROM ${table} WHERE ${cond} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`, ...args, limit, offset);
      return { rows, total: n, total_debt: debt };
    });

    r.post(`/api/${table}`, kind.access, ({ body }) => tx(() => get(`SELECT * FROM ${table} WHERE id = ?`, createPartner(table, body))));

    r.put(`/api/${table}/:id`, kind.access, ({ params, body }) => tx(() => {
      const p = get(`SELECT * FROM ${table} WHERE id = ?`, params.id);
      if (!p) throw notFound();
      const name = required(body.name ?? p.name, 'tên');
      const phone = toText(body.phone ?? p.phone, 20);
      run(
        `UPDATE ${table} SET name=?, phone=?, address=?, tax_code=?, note=?, search_text=? WHERE id=?`,
        name, phone, toText(body.address ?? p.address), toText(body.tax_code ?? p.tax_code, 20), toText(body.note ?? p.note),
        norm(`${p.code} ${name} ${phone}`), p.id,
      );
      return get(`SELECT * FROM ${table} WHERE id = ?`, p.id);
    }));

    r.delete(`/api/${table}/:id`, kind.access, ({ params }) => tx(() => {
      const p = get(`SELECT * FROM ${table} WHERE id = ?`, params.id);
      if (!p) throw notFound();
      if (p.debt > 0) throw conflict('Không thể xóa khi còn công nợ');
      run(`UPDATE ${table} SET active = 0 WHERE id = ?`, p.id);
      return { ok: true };
    }));

    r.get(`/api/${table}/:id/history`, kind.access, ({ params }) => {
      const p = get(`SELECT * FROM ${table} WHERE id = ?`, params.id);
      if (!p) throw notFound();
      return {
        partner: p,
        docs: all(`SELECT id, code, total, paid, debt, status, created_at FROM ${kind.docTable} WHERE ${kind.docFk} = ? ORDER BY id DESC LIMIT 200`, p.id),
        payments: all(
          "SELECT id, code, method, amount, note, status, created_at FROM cash_entries WHERE partner_type = ? AND partner_id = ? AND source = 'debt' ORDER BY id DESC LIMIT 200",
          kind.partnerType, p.id,
        ),
      };
    });

    r.post(`/api/${table}/:id/pay`, kind.access, ({ params, body, user }) => tx(() => {
      const p = get(`SELECT * FROM ${table} WHERE id = ?`, params.id);
      if (!p) throw notFound();
      const method = METHODS.includes(body.method) ? body.method : 'cash';
      const entry = settleDebt(table, p, toMoney(body.amount), method, toText(body.note), user.id);
      return { ...entry, debt: p.debt - toMoney(body.amount) };
    }));
  }
}
