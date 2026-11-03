import { api, html, mount, $, money, toast, showError, openModal, confirmBox, pager, fmtDateTime, isoDate, daysAgo, METHOD_LABEL } from '../core.js';

const LIMIT = 40;
const state = { from: daysAgo(30), to: isoDate(), type: '', method: '', page: 1, rows: [] };
const IN_CATEGORIES = ['Thu khác', 'Góp vốn', 'Số dư đầu kỳ'];
const OUT_CATEGORIES = ['Tiền thuê mặt bằng', 'Tiền lương', 'Điện nước, Internet', 'Vận chuyển', 'Chi khác', 'Rút vốn'];
const NON_PNL = new Set(['Góp vốn', 'Số dư đầu kỳ', 'Rút vốn']);

function entryModal(type) {
  const cats = type === 'in' ? IN_CATEGORIES : OUT_CATEGORIES;
  openModal({
    title: type === 'in' ? 'Lập phiếu thu' : 'Lập phiếu chi',
    body: html`<div class="form-grid">
      <label class="field"><span>Số tiền</span><input class="money" name="amount" value="" inputmode="numeric" required></label>
      <label class="field"><span>Hình thức</span><select name="method">${Object.entries(METHOD_LABEL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
      <label class="field"><span>Loại ${type === 'in' ? 'thu' : 'chi'}</span><select name="category" id="cb-cat">${cats.map((c) => html`<option>${c}</option>`)}</select></label>
      <label class="field"><span>${type === 'in' ? 'Người nộp' : 'Người nhận'}</span><input name="partner_name"></label>
      <label class="field full"><span>Ghi chú</span><input name="note"></label>
      <label class="check full"><input type="checkbox" name="in_pnl" id="cb-pnl"> Tính vào kết quả kinh doanh (lãi lỗ)</label>
    </div>`,
    onMount: (root) => {
      const cat = $('#cb-cat', root);
      const pnl = $('#cb-pnl', root);
      const sync = () => { pnl.checked = !NON_PNL.has(cat.value); };
      cat.addEventListener('change', sync);
      sync();
    },
    onSubmit: async (data) => {
      const res = await api('/cashbook', { method: 'POST', body: { ...data, type } });
      toast(`Đã tạo ${res.code}`);
      load();
    },
  });
}

async function load() {
  const box = $('#cb-table');
  if (!box) return;
  const res = await api('/cashbook', { query: { from: state.from, to: state.to, type: state.type, method: state.method, page: state.page, limit: LIMIT } });
  state.rows = res.rows;
  const s = res.summary;
  mount(box, html`
    <div class="stats">
      <div class="stat"><div class="label">Quỹ đầu kỳ</div><div class="value">${money(s.opening)}</div></div>
      <div class="stat"><div class="label">Tổng thu</div><div class="value good">${money(s.total_in)}</div></div>
      <div class="stat"><div class="label">Tổng chi</div><div class="value bad">${money(s.total_out)}</div></div>
      <div class="stat"><div class="label">Tồn quỹ cuối kỳ</div><div class="value">${money(s.closing)}</div></div>
    </div>
    <div class="table-wrap">${res.rows.length ? html`<table class="data">
      <thead><tr><th>Mã phiếu</th><th>Thời gian</th><th>Loại</th><th class="hide-sm">Đối tác</th><th>Hình thức</th><th class="hide-sm">Chứng từ</th><th class="num">Số tiền</th><th></th></tr></thead>
      <tbody>${res.rows.map((e) => html`<tr>
        <td class="strong">${e.code}</td><td class="nowrap">${fmtDateTime(e.created_at)}</td><td>${e.category}${e.note ? html`<br><span class="small muted">${e.note}</span>` : ''}</td>
        <td class="hide-sm">${e.partner_name}</td><td>${METHOD_LABEL[e.method]}</td><td class="hide-sm">${e.ref_code}</td>
        <td class="num ${e.status === 'cancelled' ? 'muted' : e.type === 'in' ? 'good' : 'bad'}">${e.type === 'in' ? '+' : '-'}${money(e.amount)}</td>
        <td class="num">${e.status === 'cancelled' ? html`<span class="badge badge-bad">Đã hủy</span>` : ['manual', 'debt'].includes(e.source) ? html`<button class="btn btn-sm" data-cancel="${e.id}">Hủy</button>` : ''}</td></tr>`)}
      </tbody></table>` : html`<div class="empty">Không có phiếu nào trong khoảng thời gian này.</div>`}</div>
    ${pager(res.total, state.page, LIMIT)}`);
}

export async function render(root) {
  state.page = 1;
  mount(root, html`
    <div class="page-head"><h1>Sổ quỹ</h1><span class="spacer"></span>
      <button class="btn" id="cb-in">+ Phiếu thu</button><button class="btn" id="cb-out">+ Phiếu chi</button></div>
    <div class="toolbar">
      <label class="check">Từ <input type="date" id="cb-from" value="${state.from}"></label>
      <label class="check">đến <input type="date" id="cb-to" value="${state.to}"></label>
      <select id="cb-type" aria-label="Lọc loại phiếu"><option value="">Thu và chi</option><option value="in">Chỉ phiếu thu</option><option value="out">Chỉ phiếu chi</option></select>
      <select id="cb-method" aria-label="Lọc hình thức"><option value="">Mọi hình thức</option>${Object.entries(METHOD_LABEL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select>
    </div>
    <div id="cb-table"></div>`);
  await load();
  const fields = { 'cb-from': 'from', 'cb-to': 'to', 'cb-type': 'type', 'cb-method': 'method' };
  root.addEventListener('change', (e) => {
    const key = fields[e.target.id];
    if (!key) return;
    state[key] = e.target.value;
    state.page = 1;
    load().catch(showError);
  });
  root.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('#cb-in')) return entryModal('in');
    if (t.closest('#cb-out')) return entryModal('out');
    const page = t.closest('[data-page]');
    if (page) {
      state.page = Number(page.dataset.page);
      return load().catch(showError);
    }
    const cancel = t.closest('[data-cancel]');
    if (cancel) {
      if (!(await confirmBox('Hủy phiếu', 'Hủy phiếu này? Nếu là phiếu thu/trả nợ, công nợ sẽ được khôi phục.', 'Hủy phiếu'))) return undefined;
      try {
        await api(`/cashbook/${cancel.dataset.cancel}/cancel`, { method: 'POST' });
        toast('Đã hủy phiếu');
        await load();
      } catch (err) {
        showError(err);
      }
    }
    return undefined;
  });
}
