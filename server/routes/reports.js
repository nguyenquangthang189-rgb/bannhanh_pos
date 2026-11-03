import { all, get } from '../db.js';
import { dateRange, now, today } from '../util.js';

/** Doanh thu không gồm thuế GTGT. Trả hàng ghi giảm vào ngày phát sinh phiếu trả. */
function salesTotals(start, end) {
  const inv = get(
    `SELECT COUNT(*) AS invoice_count, COALESCE(SUM(subtotal),0) AS subtotal, COALESCE(SUM(discount),0) AS discount,
            COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(cost_total),0) AS cost
     FROM invoices WHERE status = 'completed' AND created_at >= ? AND created_at < ?`,
    start, end,
  );
  const ret = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(net_amount),0) AS net, COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(cost_total),0) AS cost
     FROM returns WHERE created_at >= ? AND created_at < ?`,
    start, end,
  );
  const revenue = inv.subtotal - inv.discount - ret.net;
  const cogs = inv.cost - ret.cost;
  return {
    invoice_count: inv.invoice_count,
    gross_sales: inv.subtotal,
    discount: inv.discount,
    return_count: ret.n,
    returns: ret.net,
    revenue,
    tax: inv.tax - ret.tax,
    cogs,
    gross_profit: revenue - cogs,
  };
}

function dailySeries(start, end) {
  const days = new Map();
  const bucket = (day) => {
    if (!days.has(day)) days.set(day, { day, invoice_count: 0, revenue: 0, cogs: 0, returns: 0 });
    return days.get(day);
  };
  for (const row of all(
    `SELECT date(created_at) AS day, COUNT(*) AS n, SUM(subtotal - discount) AS revenue, SUM(cost_total) AS cost
     FROM invoices WHERE status = 'completed' AND created_at >= ? AND created_at < ? GROUP BY day`,
    start, end,
  )) {
    const b = bucket(row.day);
    b.invoice_count = row.n;
    b.revenue += row.revenue;
    b.cogs += row.cost;
  }
  for (const row of all(
    'SELECT date(created_at) AS day, SUM(net_amount) AS net, SUM(cost_total) AS cost FROM returns WHERE created_at >= ? AND created_at < ? GROUP BY day',
    start, end,
  )) {
    const b = bucket(row.day);
    b.returns = row.net;
    b.revenue -= row.net;
    b.cogs -= row.cost;
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, profit: d.revenue - d.cogs }));
}

function productReport(start, end, limit = 500) {
  return all(
    `SELECT product_id, code, name, unit, SUM(sold) AS sold, SUM(returned) AS returned, SUM(revenue) AS revenue, SUM(cost) AS cost, SUM(revenue) - SUM(cost) AS profit
     FROM (
       SELECT ii.product_id, ii.code, ii.name, ii.unit, ii.qty AS sold, 0 AS returned,
              ROUND(ii.line_total * (1.0 - i.discount * 1.0 / NULLIF(i.subtotal, 0))) AS revenue, ROUND(ii.qty * ii.cost_price) AS cost
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.status = 'completed' AND i.created_at >= ? AND i.created_at < ?
       UNION ALL
       SELECT ri.product_id, ii.code, ii.name, ii.unit, 0, ri.qty, -ri.amount, -ROUND(ri.qty * ri.cost_price)
       FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN invoice_items ii ON ii.id = ri.invoice_item_id
       WHERE r.created_at >= ? AND r.created_at < ?
     )
     GROUP BY product_id ORDER BY revenue DESC LIMIT ?`,
    start, end, start, end, limit,
  );
}

export function register(r) {
  r.get('/api/reports/dashboard', 'admin', () => {
    const t = today();
    const dayStart = (offset) => {
      const d = new Date(`${t}T00:00:00`);
      d.setDate(d.getDate() + offset);
      return now(d);
    };
    const series = dailySeries(dayStart(-29), dayStart(1));
    const byDay = new Map(series.map((s) => [s.day, s]));
    const chart = [];
    for (let i = -29; i <= 0; i += 1) {
      const day = dayStart(i).slice(0, 10);
      chart.push(byDay.get(day) ?? { day, invoice_count: 0, revenue: 0, cogs: 0, returns: 0, profit: 0 });
    }
    return {
      today: salesTotals(dayStart(0), dayStart(1)),
      yesterday: salesTotals(dayStart(-1), dayStart(0)),
      chart,
      top_products: productReport(dayStart(-29), dayStart(1), 6),
      low_stock: all('SELECT id, code, name, unit, stock, min_stock FROM products WHERE active = 1 AND track_stock = 1 AND stock <= min_stock ORDER BY stock - min_stock LIMIT 8'),
      receivable: get('SELECT COALESCE(SUM(debt),0) AS v FROM customers').v,
      payable: get('SELECT COALESCE(SUM(debt),0) AS v FROM suppliers').v,
      inventory_value: get('SELECT COALESCE(SUM(ROUND(MAX(stock,0) * cost_price)),0) AS v FROM products WHERE active = 1 AND track_stock = 1').v,
    };
  });

  r.get('/api/reports/profit', 'admin', ({ query }) => {
    const { start, end, from, to } = dateRange(query);
    const totals = salesTotals(start, end);
    const other = get(
      `SELECT COALESCE(SUM(CASE WHEN type='in' THEN amount END),0) AS other_income, COALESCE(SUM(CASE WHEN type='out' THEN amount END),0) AS other_expense
       FROM cash_entries WHERE status='active' AND in_pnl = 1 AND created_at >= ? AND created_at < ?`,
      start, end,
    );
    const stockDiff = get('SELECT COALESCE(SUM(diff_value),0) AS v FROM stock_takes WHERE created_at >= ? AND created_at < ?', start, end).v;
    return {
      from, to,
      ...totals,
      ...other,
      stock_diff: stockDiff,
      net_profit: totals.gross_profit + other.other_income - other.other_expense + stockDiff,
      days: dailySeries(start, end),
      by_method: all(
        `SELECT method, COALESCE(SUM(CASE WHEN type='in' THEN amount ELSE -amount END),0) AS amount FROM cash_entries
         WHERE status='active' AND source IN ('sale','return') AND created_at >= ? AND created_at < ? GROUP BY method`,
        start, end,
      ),
      by_user: all(
        `SELECT u.full_name AS name, COUNT(*) AS invoice_count, SUM(i.total) AS total FROM invoices i JOIN users u ON u.id = i.user_id
         WHERE i.status='completed' AND i.created_at >= ? AND i.created_at < ? GROUP BY u.id ORDER BY total DESC`,
        start, end,
      ),
    };
  });

  r.get('/api/reports/products', 'admin', ({ query }) => {
    const { start, end, from, to } = dateRange(query);
    return { from, to, rows: productReport(start, end) };
  });

  r.get('/api/reports/inventory', 'admin', () => {
    const rows = all(
      `SELECT p.id, p.code, p.name, p.unit, p.stock, p.min_stock, p.cost_price, p.sale_price, c.name AS category_name,
              ROUND(MAX(p.stock, 0) * p.cost_price) AS stock_value, ROUND(MAX(p.stock, 0) * p.sale_price) AS sale_value
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1 AND p.track_stock = 1 ORDER BY stock_value DESC`,
    );
    return {
      rows,
      total_value: rows.reduce((s, x) => s + x.stock_value, 0),
      total_sale_value: rows.reduce((s, x) => s + x.sale_value, 0),
    };
  });

  // Báo cáo cuối ngày: thu ngân đối chiếu tiền trong két.
  r.get('/api/reports/eod', ({ query }) => {
    const { start, end, from } = dateRange({ from: query.date, to: query.date });
    const t = salesTotals(start, end);
    const sign = "CASE WHEN type='in' THEN amount ELSE -amount END";
    return {
      date: from,
      invoice_count: t.invoice_count,
      return_count: t.return_count,
      gross_sales: t.gross_sales,
      discount: t.discount,
      returns: t.returns,
      tax: t.tax,
      revenue: t.revenue,
      debt_created: get("SELECT COALESCE(SUM(total - paid),0) AS v FROM invoices WHERE status='completed' AND id NOT IN (SELECT doc_id FROM debt_allocations WHERE doc_type='invoice') AND created_at >= ? AND created_at < ?", start, end).v,
      by_method: all(
        `SELECT method, COALESCE(SUM(CASE WHEN type='in' THEN amount END),0) AS total_in, COALESCE(SUM(CASE WHEN type='out' THEN amount END),0) AS total_out
         FROM cash_entries WHERE status='active' AND created_at >= ? AND created_at < ? GROUP BY method`,
        start, end,
      ),
      cash_opening: get(`SELECT COALESCE(SUM(${sign}),0) AS v FROM cash_entries WHERE status='active' AND method='cash' AND created_at < ?`, start).v,
      cash_closing: get(`SELECT COALESCE(SUM(${sign}),0) AS v FROM cash_entries WHERE status='active' AND method='cash' AND created_at < ?`, end).v,
    };
  });
}
