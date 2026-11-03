import { api, html, mount, $, $$, isAdmin, money, qtyFmt, showError, fmtDate, isoDate, daysAgo, downloadCsv, METHOD_LABEL } from '../core.js';

const TABS = [
  { id: 'profit', label: 'Lãi lỗ và doanh thu', admin: true },
  { id: 'products', label: 'Theo hàng hóa', admin: true },
  { id: 'inventory', label: 'Tồn kho', admin: true },
  { id: 'eod', label: 'Cuối ngày' },
];
const state = { tab: 'profit', from: daysAgo(29), to: isoDate(), exportFn: null };

const signed = (n) => `${n < 0 ? '-' : ''}${money(Math.abs(n))}`;

async function renderProfit(box) {
  const d = await api('/reports/profit', { query: { from: state.from, to: state.to } });
  state.exportFn = () => downloadCsv(`doanh-thu-${d.from}-${d.to}.csv`,
    ['Ngày', 'Số hóa đơn', 'Doanh thu thuần', 'Giá vốn', 'Lợi nhuận gộp', 'Trả hàng'],
    d.days.map((r) => [r.day, r.invoice_count, r.revenue, r.cogs, r.profit, r.returns]));
  mount(box, html`
    <div class="grid-even">
      <div class="card">
        <h3>Kết quả kinh doanh</h3>
        <div class="kv"><span>Tiền hàng bán ra</span><span class="num">${money(d.gross_sales)}</span></div>
        <div class="kv"><span>Giảm giá</span><span class="num">-${money(d.discount)}</span></div>
        <div class="kv"><span>Hàng trả lại (${d.return_count} phiếu)</span><span class="num">-${money(d.returns)}</span></div>
        <div class="kv total"><span>Doanh thu thuần</span><span class="num">${signed(d.revenue)}</span></div>
        <div class="kv"><span>Giá vốn hàng bán</span><span class="num">-${money(d.cogs)}</span></div>
        <div class="kv total"><span>Lợi nhuận gộp</span><span class="num">${signed(d.gross_profit)}</span></div>
        <div class="kv"><span>Thu nhập khác</span><span class="num">${money(d.other_income)}</span></div>
        <div class="kv"><span>Chi phí khác</span><span class="num">-${money(d.other_expense)}</span></div>
        <div class="kv"><span>Chênh lệch kiểm kho</span><span class="num">${signed(d.stock_diff)}</span></div>
        <div class="kv total"><span>Lợi nhuận ròng</span><span class="num ${d.net_profit < 0 ? 'bad' : 'good'}">${signed(d.net_profit)}</span></div>
        <p class="hint" style="margin-top:8px">Doanh thu chưa gồm thuế GTGT. Thuế GTGT phát sinh trong kỳ: ${money(d.tax)} đ. Đây là số liệu quản trị nội bộ, không thay thế sổ sách kế toán thuế.</p>
      </div>
      <div>
        <div class="card"><h3>Tiền bán hàng theo hình thức</h3>
          ${d.by_method.length ? d.by_method.map((m) => html`<div class="kv"><span>${METHOD_LABEL[m.method] ?? m.method}</span><span class="num">${signed(m.amount)}</span></div>`) : html`<p class="muted">Chưa có giao dịch.</p>`}</div>
        <div class="card"><h3>Theo thu ngân</h3>
          ${d.by_user.length ? d.by_user.map((u) => html`<div class="kv"><span>${u.name} <span class="small muted">(${u.invoice_count} hóa đơn)</span></span><span class="num">${money(u.total)}</span></div>`) : html`<p class="muted">Chưa có giao dịch.</p>`}</div>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:12px">${d.days.length ? html`<table class="data">
      <thead><tr><th>Ngày</th><th class="num">Số hóa đơn</th><th class="num">Trả hàng</th><th class="num">Doanh thu thuần</th><th class="num">Giá vốn</th><th class="num">Lợi nhuận gộp</th></tr></thead>
      <tbody>${d.days.map((r) => html`<tr><td>${fmtDate(r.day)}</td><td class="num">${r.invoice_count}</td><td class="num">${money(r.returns)}</td><td class="num">${signed(r.revenue)}</td><td class="num">${signed(r.cogs)}</td><td class="num">${signed(r.profit)}</td></tr>`)}</tbody>
    </table>` : html`<div class="empty">Không có giao dịch trong khoảng thời gian này.</div>`}</div>`);
}

async function renderProducts(box) {
  const d = await api('/reports/products', { query: { from: state.from, to: state.to } });
  state.exportFn = () => downloadCsv(`hang-hoa-ban-${d.from}-${d.to}.csv`,
    ['Mã hàng', 'Tên hàng', 'Đã bán', 'Trả lại', 'Doanh thu', 'Giá vốn', 'Lợi nhuận'],
    d.rows.map((r) => [r.code, r.name, r.sold, r.returned, r.revenue, r.cost, r.profit]));
  mount(box, html`<div class="table-wrap">${d.rows.length ? html`<table class="data">
    <thead><tr><th>Mã hàng</th><th>Tên hàng</th><th class="num">Đã bán</th><th class="num">Trả lại</th><th class="num">Doanh thu</th><th class="num">Giá vốn</th><th class="num">Lợi nhuận</th></tr></thead>
    <tbody>${d.rows.map((r) => html`<tr><td class="nowrap">${r.code}</td><td>${r.name}</td><td class="num">${qtyFmt(r.sold)} ${r.unit}</td><td class="num">${qtyFmt(r.returned)}</td><td class="num">${signed(r.revenue)}</td><td class="num">${signed(r.cost)}</td><td class="num ${r.profit < 0 ? 'bad' : ''}">${signed(r.profit)}</td></tr>`)}</tbody>
  </table>` : html`<div class="empty">Không có giao dịch trong khoảng thời gian này.</div>`}</div>`);
}

async function renderInventory(box) {
  const d = await api('/reports/inventory');
  state.exportFn = () => downloadCsv(`ton-kho-${isoDate()}.csv`,
    ['Mã hàng', 'Tên hàng', 'Nhóm', 'Tồn', 'Giá vốn', 'Giá trị tồn', 'Giá bán', 'Giá trị theo giá bán'],
    d.rows.map((r) => [r.code, r.name, r.category_name, r.stock, r.cost_price, r.stock_value, r.sale_price, r.sale_value]));
  mount(box, html`
    <div class="stats">
      <div class="stat"><div class="label">Giá trị tồn theo giá vốn</div><div class="value">${money(d.total_value)}</div></div>
      <div class="stat"><div class="label">Giá trị tồn theo giá bán</div><div class="value">${money(d.total_sale_value)}</div></div>
      <div class="stat"><div class="label">Số mặt hàng</div><div class="value">${money(d.rows.length)}</div></div>
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Mã hàng</th><th>Tên hàng</th><th class="hide-sm">Nhóm</th><th class="num">Tồn</th><th class="num">Giá vốn</th><th class="num">Giá trị tồn</th></tr></thead>
      <tbody>${d.rows.map((r) => html`<tr><td class="nowrap">${r.code}</td><td>${r.name}</td><td class="hide-sm muted">${r.category_name}</td><td class="num ${r.stock <= r.min_stock ? 'bad' : ''}">${qtyFmt(r.stock)} ${r.unit}</td><td class="num">${money(r.cost_price)}</td><td class="num">${money(r.stock_value)}</td></tr>`)}</tbody>
    </table></div>`);
}

async function renderEod(box) {
  const d = await api('/reports/eod', { query: { date: state.to } });
  state.exportFn = null;
  mount(box, html`<div class="card" style="max-width:560px">
    <h3>Ngày ${fmtDate(d.date)}</h3>
    <div class="kv"><span>Số hóa đơn</span><span class="num">${d.invoice_count}</span></div>
    <div class="kv"><span>Tiền hàng</span><span class="num">${money(d.gross_sales)}</span></div>
    <div class="kv"><span>Giảm giá</span><span class="num">${money(d.discount)}</span></div>
    <div class="kv"><span>Trả hàng (${d.return_count} phiếu)</span><span class="num">${money(d.returns)}</span></div>
    <div class="kv"><span>Thuế GTGT</span><span class="num">${money(d.tax)}</span></div>
    <div class="kv total"><span>Doanh thu thuần</span><span class="num">${signed(d.revenue)}</span></div>
    <h3 style="margin-top:14px">Dòng tiền</h3>
    ${d.by_method.length ? d.by_method.map((m) => html`<div class="kv"><span>${METHOD_LABEL[m.method] ?? m.method}</span><span class="num">Thu ${money(m.total_in)} · Chi ${money(m.total_out)}</span></div>`) : html`<p class="muted">Không có phát sinh.</p>`}
    <div class="kv"><span>Tiền mặt đầu ngày</span><span class="num">${signed(d.cash_opening)}</span></div>
    <div class="kv total"><span>Tiền mặt cuối ngày theo sổ</span><span class="num">${signed(d.cash_closing)}</span></div>
  </div>`);
}

const RENDERERS = { profit: renderProfit, products: renderProducts, inventory: renderInventory, eod: renderEod };

async function load(root) {
  const box = $('#rp-body', root);
  const controls = $('#rp-controls', root);
  $('#rp-from-wrap', root).hidden = state.tab === 'eod' || state.tab === 'inventory';
  $('#rp-to-wrap', root).hidden = state.tab === 'inventory';
  $('#rp-to-label', root).textContent = state.tab === 'eod' ? 'Ngày' : 'đến';
  controls.hidden = false;
  await RENDERERS[state.tab](box);
  $('#rp-export', root).hidden = !state.exportFn;
}

export async function render(root) {
  const tabs = TABS.filter((t) => !t.admin || isAdmin());
  if (!tabs.some((t) => t.id === state.tab)) state.tab = tabs[0].id;
  mount(root, html`
    <div class="page-head"><h1>Báo cáo</h1></div>
    <div class="tabs" role="tablist">${tabs.map((t) => html`<button data-tab="${t.id}" class="${t.id === state.tab ? 'active' : ''}">${t.label}</button>`)}</div>
    <div class="toolbar" id="rp-controls">
      <label class="check" id="rp-from-wrap">Từ <input type="date" id="rp-from" value="${state.from}"></label>
      <label class="check" id="rp-to-wrap"><span id="rp-to-label">đến</span> <input type="date" id="rp-to" value="${state.to}"></label>
      <span class="spacer"></span>
      <button class="btn" id="rp-export">Xuất CSV</button>
    </div>
    <div id="rp-body"></div>`);
  await load(root);
  root.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab;
      $$('.tabs button', root).forEach((b) => b.classList.toggle('active', b === tabBtn));
      load(root).catch(showError);
    }
    if (e.target.closest('#rp-export')) state.exportFn?.();
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'rp-from') state.from = e.target.value;
    else if (e.target.id === 'rp-to') state.to = e.target.value;
    else return;
    load(root).catch(showError);
  });
}
