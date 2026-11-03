import { all, get, run, tx, addCashEntry } from '../db.js';
import { bad, conflict, notFound, dateRange, paging, required, toMoney, toText } from '../util.js';
import { METHODS, reverseDebtEntry } from './partners.js';

export function register(r) {
  r.get('/api/cashbook', 'admin', ({ query }) => {
    const { start, end } = dateRange(query);
    const where = ['e.created_at >= ?', 'e.created_at < ?'];
    const args = [start, end];
    if (query.type) { where.push('e.type = ?'); args.push(query.type); }
    if (query.method) { where.push('e.method = ?'); args.push(query.method); }
    const cond = where.join(' AND ');
    const { limit, offset } = paging(query);
    const { n } = get(`SELECT COUNT(*) AS n FROM cash_entries e WHERE ${cond}`, ...args);
    const rows = all(
      `SELECT e.*, u.full_name AS user_name FROM cash_entries e LEFT JOIN users u ON u.id = e.user_id WHERE ${cond} ORDER BY e.id DESC LIMIT ? OFFSET ?`,
      ...args, limit, offset,
    );

    // Số dư luôn tính trên toàn bộ quỹ của từng hình thức, không phụ thuộc bộ lọc thu/chi.
    const methodCond = query.method ? 'AND method = ?' : '';
    const methodArgs = query.method ? [query.method] : [];
    const signed = "CASE WHEN type = 'in' THEN amount ELSE -amount END";
    const opening = get(`SELECT COALESCE(SUM(${signed}),0) AS v FROM cash_entries WHERE status = 'active' AND created_at < ? ${methodCond}`, start, ...methodArgs).v;
    const period = get(
      `SELECT COALESCE(SUM(CASE WHEN type='in' THEN amount END),0) AS total_in, COALESCE(SUM(CASE WHEN type='out' THEN amount END),0) AS total_out
       FROM cash_entries WHERE status = 'active' AND created_at >= ? AND created_at < ? ${methodCond}`,
      start, end, ...methodArgs,
    );
    return {
      rows,
      total: n,
      summary: { opening, total_in: period.total_in, total_out: period.total_out, closing: opening + period.total_in - period.total_out },
    };
  });

  r.post('/api/cashbook', 'admin', ({ body, user }) => tx(() => {
    if (!['in', 'out'].includes(body.type)) throw bad('Loại phiếu không hợp lệ');
    const amount = toMoney(body.amount);
    if (amount <= 0) throw bad('Số tiền phải lớn hơn 0');
    return addCashEntry({
      type: body.type,
      method: METHODS.includes(body.method) ? body.method : 'cash',
      category: required(body.category, 'loại thu/chi'),
      amount,
      source: 'manual',
      partnerName: toText(body.partner_name, 120) || null,
      inPnl: Boolean(body.in_pnl),
      note: toText(body.note),
      userId: user.id,
    });
  }));

  r.post('/api/cashbook/:id/cancel', 'admin', ({ params }) => tx(() => {
    const entry = get('SELECT * FROM cash_entries WHERE id = ?', params.id);
    if (!entry) throw notFound();
    if (entry.status !== 'active') throw conflict('Phiếu đã bị hủy trước đó');
    if (entry.source === 'debt') reverseDebtEntry(entry);
    else if (entry.source !== 'manual') throw conflict(`Phiếu này tự sinh từ chứng từ ${entry.ref_code}. Hãy hủy chứng từ gốc`);
    run("UPDATE cash_entries SET status = 'cancelled' WHERE id = ?", entry.id);
    return { ok: true };
  }));
}
