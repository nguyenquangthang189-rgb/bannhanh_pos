import { api, html, mount, $, $$, isAdmin, money, qtyFmt, parseQty, toast, showError, openModal, confirmBox, debounce, pager, fmtDateTime, isoDate, METHOD_LABEL, raw } from '../core.js';
import { setScanHandler, beep } from '../devices/scanner.js';
import { printInvoice } from '../devices/printer.js';

const LIMIT = 30;
const state = { from: isoDate(), to: isoDate(), q: '', status: '', page: 1, tab: 'invoices' };

async function loadInvoices() {
  const box = $('#inv-table');
  if (!box) return;
  const res = await api('/invoices', { query: { from: state.from, to: state.to, q: state.q, status: state.status, page: state.page, limit: LIMIT } });
  mount(box, html`
    <div class="stats">
      <div class="stat"><div class="label">Số hóa đơn</div><div class="value">${money(res.total)}</div></div>
      <div class="stat"><div class="label">Tổng tiền (không tính hóa đơn hủy)</div><div class="value">${money(res.sum_total)}</div></div>
      <div class="stat"><div class="label">Khách còn nợ</div><div class="value">${money(res.sum_debt)}</div></div>
    </div>
    <div class="table-wrap">
    ${res.rows.length ? html`<table class="data">
      <thead><tr><th>Mã hóa đơn</th><th>Thời gian</th><th>Khách hàng</th><th class="hide-sm">Thu ngân</th><th class="num">Tổng tiền</th><th class="num">Còn nợ</th><th class="hide-sm">Thanh toán</th><th>Trạng thái</th></tr></thead>
      <tbody>${res.rows.map((i) => html`<tr class="clickable" data-id="${i.id}">
        <td class="strong">${i.code}</td><td class="nowrap">${fmtDateTime(i.created_at)}</td><td>${i.customer_name ?? 'Khách lẻ'}</td><td class="hide-sm">${i.user_name}</td>
        <td class="num">${money(i.total)}</td><td class="num ${i.debt ? 'bad' : ''}">${money(i.debt)}</td><td class="hide-sm">${METHOD_LABEL[i.method]}</td>
        <td>${i.status === 'cancelled' ? html`<span class="badge badge-bad">Đã hủy</span>` : i.returned_total ? html`<span class="badge badge-warn">Có trả hàng</span>` : html`<span class="badge badge-good">Hoàn thành</span>`}</td></tr>`)}
      </tbody></table>` : html`<div class="empty">Không có hóa đơn trong khoảng thời gian này.</div>`}
    </div>${pager(res.total, state.page, LIMIT)}`);
}

async function loadReturns() {
  const box = $('#inv-table');
  if (!box) return;
  const res = await api('/returns', { query: { from: state.from, to: state.to, page: state.page, limit: LIMIT } });
  mount(box, html`<div class="table-wrap">
    ${res.rows.length ? html`<table class="data">
      <thead><tr><th>Mã phiếu</th><th>Thời gian</th><th>Hóa đơn gốc</th><th>Khách hàng</th><th class="num">Giá trị trả</th><th class="num">Trừ nợ</th><th class="num">Hoàn tiền</th></tr></thead>
      <tbody>${res.rows.map((r) => html`<tr class="clickable" data-id="${r.invoice_id}">
        <td class="strong">${r.code}</td><td class="nowrap">${fmtDateTime(r.created_at)}</td><td>${r.invoice_code}</td><td>${r.customer_name ?? 'Khách lẻ'}</td>
        <td class="num">${money(r.total)}</td><td class="num">${money(r.debt_reduced)}</td><td class="num">${money(r.refund)}</td></tr>`)}
      </tbody></table>` : html`<div class="empty">Không có phiếu trả hàng trong khoảng thời gian này.</div>`}
    </div>${pager(res.total, state.page, LIMIT)}`);
}

const load = () => (state.tab === 'returns' ? loadReturns() : loadInvoices());

function returnModal(inv, afterDone) {
  const lines = inv.items.filter((i) => i.qty > i.returned_qty);
  if (!lines.length) return showError(new Error('Hóa đơn đã trả hết hàng'));
  openModal({
    title: `Trả hàng cho ${inv.code}`,
    wide: true,
    submitLabel: 'Tạo phiếu trả',
    body: html`
      <div class="table-wrap" style="margin-bottom:12px"><table class="data">
        <thead><tr><th>Hàng hóa</th><th class="num">Đã mua</th><th class="num">Đã trả</th><th style="width:110px">Số lượng trả</th></tr></thead>
        <tbody>${lines.map((i) => html`<tr>
          <td>${i.name}</td><td class="num">${qtyFmt(i.qty)}</td><td class="num">${qtyFmt(i.returned_qty)}</td>
          <td><input data-ret="${i.id}" value="0" inputmode="decimal" style="text-align:right" aria-label="Số lượng trả ${i.name}"></td></tr>`)}
        </tbody></table></div>
      <div class="form-grid">
        <label class="field"><span>Hoàn tiền bằng</span><select name="method">${Object.entries(METHOD_LABEL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
        <label class="field"><span>Lý do</span><input name="note"></label>
        <p class="hint full">Nếu hóa đơn còn nợ, giá trị trả sẽ trừ vào công nợ trước, phần dư mới hoàn tiền. Giá trị đã tính theo chiết khấu của hóa đơn gốc.</p>
      </div>`,
    onSubmit: async (data, form) => {
      const items = $$('[data-ret]', form)
        .map((el) => ({ invoice_item_id: Number(el.dataset.ret), qty: parseQty(el.value) }))
        .filter((x) => x.qty > 0);
      if (!items.length) throw new Error('Chưa nhập số lượng trả');
      const res = await api(`/invoices/${inv.id}/returns`, { method: 'POST', body: { items, method: data.method, note: data.note } });
      toast(`Đã tạo ${res.code}: hoàn ${money(res.refund)} đ${res.debt_reduced ? `, trừ nợ ${money(res.debt_reduced)} đ` : ''}`);
      afterDone();
    },
  });
  return undefined;
}

export async function showInvoice(id) {
  const inv = await api(`/invoices/${id}`);
  const m = openModal({
    title: `Hóa đơn ${inv.code}`,
    wide: true,
    body: html`
      <p class="muted">${fmtDateTime(inv.created_at)} · Thu ngân: ${inv.user_name} · Khách: ${inv.customer_name ?? 'Khách lẻ'}
        ${inv.status === 'cancelled' ? html` · <span class="badge badge-bad">Đã hủy</span>` : ''}</p>
      <div class="table-wrap" style="margin-bottom:12px"><table class="data">
        <thead><tr><th>Hàng hóa</th><th class="num">Số lượng</th><th class="num">Đơn giá</th><th class="num">Giảm giá</th><th class="num">Thành tiền</th>${inv.returned_total ? html`<th class="num">Đã trả</th>` : ''}</tr></thead>
        <tbody>${inv.items.map((i) => html`<tr><td>${i.name}<br><span class="small muted">${i.code}</span></td><td class="num">${qtyFmt(i.qty)} ${i.unit}</td><td class="num">${money(i.price)}</td><td class="num">${money(i.discount)}</td><td class="num">${money(i.line_total)}</td>${inv.returned_total ? html`<td class="num">${qtyFmt(i.returned_qty)}</td>` : ''}</tr>`)}</tbody>
      </table></div>
      <div class="grid-even">
        <div>${inv.note ? html`<p><strong>Ghi chú:</strong> ${inv.note}</p>` : ''}
          ${inv.returns.length ? html`<h3>Phiếu trả hàng</h3>${inv.returns.map((r) => html`<div class="kv"><span>${r.code} · ${fmtDateTime(r.created_at)}</span><span class="num">${money(r.total)}</span></div>`)}` : ''}
        </div>
        <div>
          <div class="kv"><span>Tiền hàng</span><span class="num">${money(inv.subtotal)}</span></div>
          <div class="kv"><span>Giảm giá</span><span class="num">${money(inv.discount)}</span></div>
          ${inv.tax ? html`<div class="kv"><span>Thuế GTGT ${inv.tax_rate}%</span><span class="num">${money(inv.tax)}</span></div>` : ''}
          <div class="kv total"><span>Tổng cộng</span><span class="num">${money(inv.total)}</span></div>
          <div class="kv"><span>Đã thanh toán (${METHOD_LABEL[inv.method]})</span><span class="num">${money(inv.paid)}</span></div>
          <div class="kv"><span>Còn nợ</span><span class="num ${inv.debt ? 'bad' : ''}">${money(inv.debt)}</span></div>
          ${isAdmin() ? html`<div class="kv"><span>Giá vốn</span><span class="num">${money(inv.cost_total)}</span></div>` : ''}
        </div>
      </div>`,
    footer: html`
      <button type="button" class="btn" id="iv-print">In lại</button>
      ${inv.status === 'completed' ? html`<button type="button" class="btn" id="iv-return">Trả hàng</button>` : ''}
      ${inv.status === 'completed' && isAdmin() ? html`<button type="button" class="btn btn-danger" id="iv-cancel">Hủy hóa đơn</button>` : ''}`,
    onMount: (root) => {
      $('#iv-print', root).addEventListener('click', () => printInvoice(inv).then(() => toast('Đã gửi lệnh in')).catch(showError));
      $('#iv-return', root)?.addEventListener('click', () => returnModal(inv, () => {
        m.close();
        load().catch(showError);
      }));
      $('#iv-cancel', root)?.addEventListener('click', async () => {
        if (!(await confirmBox('Hủy hóa đơn', `Hủy ${inv.code}? Tồn kho, công nợ và sổ quỹ sẽ được đảo lại.`, 'Hủy hóa đơn'))) return;
        try {
          await api(`/invoices/${inv.id}/cancel`, { method: 'POST' });
          toast('Đã hủy hóa đơn');
          m.close();
          load().catch(showError);
        } catch (err) {
          showError(err);
        }
      });
    },
  });
}

function paintEod(data) {
  openModal({
    title: `Báo cáo cuối ngày ${data.date.split('-').reverse().join('/')}`,
    body: html`
      <div class="kv"><span>Số hóa đơn</span><span class="num">${data.invoice_count}</span></div>
      <div class="kv"><span>Tiền hàng</span><span class="num">${money(data.gross_sales)}</span></div>
      <div class="kv"><span>Giảm giá</span><span class="num">${money(data.discount)}</span></div>
      <div class="kv"><span>Trả hàng (${data.return_count} phiếu)</span><span class="num">${money(data.returns)}</span></div>
      <div class="kv"><span>Thuế GTGT</span><span class="num">${money(data.tax)}</span></div>
      <div class="kv total"><span>Doanh thu thuần</span><span class="num">${money(data.revenue)}</span></div>
      <h3 style="margin-top:14px">Dòng tiền theo hình thức</h3>
      ${data.by_method.map((m) => html`<div class="kv"><span>${METHOD_LABEL[m.method] ?? m.method}</span><span class="num">Thu ${money(m.total_in)} · Chi ${money(m.total_out)}</span></div>`)}
      <div class="kv total"><span>Tiền mặt cuối ngày theo sổ</span><span class="num">${money(data.cash_closing)}</span></div>
      <p class="hint">Đầu ngày ${money(data.cash_opening)} đ. Đếm tiền trong két và đối chiếu với số này.</p>`,
  });
}

export async function render(root) {
  state.page = 1;
  state.q = '';
  // Quét mã vạch in trên hóa đơn giấy để mở lại, phục vụ khách đem hàng tới trả.
  setScanHandler(async (code) => {
    try {
      const res = await api('/invoices', { query: { q: code, from: '2000-01-01', to: isoDate(), limit: 1 } });
      if (!res.rows.length) throw new Error(`Không tìm thấy hóa đơn "${code}"`);
      beep(true);
      await showInvoice(res.rows[0].id);
    } catch (err) {
      beep(false);
      showError(err);
    }
  });
  mount(root, html`
    <div class="page-head"><h1>Hóa đơn</h1><span class="spacer"></span><button class="btn" id="inv-eod">Báo cáo cuối ngày</button></div>
    <div class="tabs" role="tablist">
      <button data-tab="invoices" class="${state.tab === 'invoices' ? 'active' : ''}">Hóa đơn bán</button>
      <button data-tab="returns" class="${state.tab === 'returns' ? 'active' : ''}">Phiếu trả hàng</button>
    </div>
    <div class="toolbar">
      <input type="search" id="inv-q" placeholder="Mã hóa đơn hoặc tên khách (có thể quét mã trên hóa đơn)" aria-label="Tìm hóa đơn">
      <label class="check">Từ <input type="date" id="inv-from" value="${state.from}"></label>
      <label class="check">đến <input type="date" id="inv-to" value="${state.to}"></label>
      <select id="inv-status" aria-label="Lọc trạng thái">
        <option value="">Mọi trạng thái</option><option value="completed">Hoàn thành</option><option value="cancelled">Đã hủy</option>
      </select>
    </div>
    <div id="inv-table"></div>`);
  await load();
  $('#inv-q', root).addEventListener('input', debounce((e) => { state.q = e.target.value; state.page = 1; load().catch(showError); }));
  root.addEventListener('change', (e) => {
    if (e.target.id === 'inv-from') state.from = e.target.value;
    else if (e.target.id === 'inv-to') state.to = e.target.value;
    else if (e.target.id === 'inv-status') state.status = e.target.value;
    else return;
    state.page = 1;
    load().catch(showError);
  });
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#inv-eod')) return void api('/reports/eod', { query: { date: isoDate() } }).then(paintEod).catch(showError);
    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab;
      state.page = 1;
      $$('.tabs button', root).forEach((b) => b.classList.toggle('active', b === tabBtn));
      return void load().catch(showError);
    }
    const page = t.closest('[data-page]');
    if (page) {
      state.page = Number(page.dataset.page);
      return void load().catch(showError);
    }
    const row = t.closest('tr[data-id]');
    if (row) showInvoice(row.dataset.id).catch(showError);
    return undefined;
  });
}
