import { api, html, mount, raw, $, money, toast, showError, openModal, confirmBox, debounce, pager, fmtDateTime, METHOD_LABEL } from '../core.js';

const LIMIT = 30;
const KINDS = {
  customers: { title: 'Khách hàng', one: 'khách hàng', debtLabel: 'Đang nợ', totalLabel: 'Tổng mua', payLabel: 'Thu nợ', docLabel: 'Hóa đơn' },
  suppliers: { title: 'Nhà cung cấp', one: 'nhà cung cấp', debtLabel: 'Cần trả', totalLabel: 'Tổng nhập', payLabel: 'Trả nợ', docLabel: 'Phiếu nhập' },
};
const state = { kind: 'customers', q: '', debt: false, page: 1, rows: [] };

function form(p = {}) {
  return html`<div class="form-grid">
    <label class="field full"><span>Tên</span><input name="name" value="${p.name ?? ''}" required></label>
    <label class="field"><span>Điện thoại</span><input name="phone" value="${p.phone ?? ''}" inputmode="tel"></label>
    <label class="field"><span>Mã số thuế</span><input name="tax_code" value="${p.tax_code ?? ''}"></label>
    <label class="field full"><span>Địa chỉ</span><input name="address" value="${p.address ?? ''}"></label>
    <label class="field full"><span>Ghi chú</span><textarea name="note">${p.note ?? ''}</textarea></label>
  </div>`;
}

function edit(p) {
  const k = KINDS[state.kind];
  const m = openModal({
    title: p ? `Sửa ${p.name}` : `Thêm ${k.one}`,
    body: form(p ?? {}),
    footer: p ? html`<button type="button" class="btn btn-danger" id="pt-del">Xóa</button>` : '',
    onMount: (root) => $('#pt-del', root)?.addEventListener('click', async () => {
      if (!(await confirmBox(`Xóa ${k.one}`, `Xóa "${p.name}"? Chứng từ cũ vẫn được giữ.`, 'Xóa'))) return;
      try {
        await api(`/${state.kind}/${p.id}`, { method: 'DELETE' });
        m.close();
        load();
      } catch (err) {
        showError(err);
      }
    }),
    onSubmit: async (data) => {
      await api(p ? `/${state.kind}/${p.id}` : `/${state.kind}`, { method: p ? 'PUT' : 'POST', body: data });
      toast('Đã lưu');
      load();
    },
  });
}

function pay(p) {
  const k = KINDS[state.kind];
  openModal({
    title: `${k.payLabel}: ${p.name}`,
    submitLabel: k.payLabel,
    body: html`<div class="form-grid">
      <div class="full kv total"><span>Công nợ hiện tại</span><span class="num bad">${money(p.debt)} đ</span></div>
      <label class="field"><span>Số tiền</span><input class="money" name="amount" value="${money(p.debt)}" inputmode="numeric"></label>
      <label class="field"><span>Hình thức</span><select name="method">${Object.entries(METHOD_LABEL).map(([key, v]) => html`<option value="${key}">${v}</option>`)}</select></label>
      <label class="field full"><span>Ghi chú</span><input name="note"></label>
    </div>`,
    onSubmit: async (data) => {
      const res = await api(`/${state.kind}/${p.id}/pay`, { method: 'POST', body: data });
      toast(`Đã tạo ${res.code}. Còn nợ ${money(res.debt)} đ`);
      load();
    },
  });
}

async function history(p) {
  const k = KINDS[state.kind];
  const h = await api(`/${state.kind}/${p.id}/history`);
  const statusBadge = (s) => (s === 'completed' ? '' : html`<span class="badge badge-bad">Đã hủy</span>`);
  openModal({
    title: `Lịch sử: ${p.name}`,
    wide: true,
    body: html`<div class="grid-even">
      <div><h3>${k.docLabel}</h3>
        ${h.docs.length ? h.docs.map((d) => html`<div class="kv"><span>${d.code} ${statusBadge(d.status)}<br><span class="small muted">${fmtDateTime(d.created_at)}</span></span>
          <span class="num">${money(d.total)}${d.debt ? html`<br><span class="small bad">Nợ ${money(d.debt)}</span>` : ''}</span></div>`) : html`<p class="muted">Chưa có.</p>`}
      </div>
      <div><h3>Thanh toán công nợ</h3>
        ${h.payments.length ? h.payments.map((d) => html`<div class="kv"><span>${d.code} ${d.status === 'cancelled' ? html`<span class="badge badge-bad">Đã hủy</span>` : ''}<br><span class="small muted">${fmtDateTime(d.created_at)} · ${METHOD_LABEL[d.method]}</span></span>
          <span class="num">${money(d.amount)}</span></div>`) : html`<p class="muted">Chưa có.</p>`}
      </div>
    </div>`,
  });
}

async function load() {
  const box = $('#pt-table');
  if (!box) return;
  const k = KINDS[state.kind];
  const res = await api(`/${state.kind}`, { query: { q: state.q, debt: state.debt ? 1 : '', page: state.page, limit: LIMIT } });
  state.rows = res.rows;
  const hint = $('#pt-total');
  if (hint) hint.textContent = `Tổng công nợ: ${money(res.total_debt)} đ`;
  mount(box, html`<div class="table-wrap">
    ${res.rows.length ? html`<table class="data">
      <thead><tr><th>Mã</th><th>Tên</th><th>Điện thoại</th><th class="hide-sm">Địa chỉ</th><th class="num">${k.totalLabel}</th><th class="num">${k.debtLabel}</th><th></th></tr></thead>
      <tbody>${res.rows.map((p) => html`<tr class="clickable" data-id="${p.id}">
        <td class="nowrap">${p.code}</td><td class="strong">${p.name}</td><td class="nowrap">${p.phone}</td><td class="hide-sm muted">${p.address}</td>
        <td class="num">${money(p.total_amount)}</td><td class="num ${p.debt ? 'bad strong' : ''}">${money(p.debt)}</td>
        <td class="num nowrap" data-stop>
          <button class="btn btn-sm" data-history="${p.id}">Lịch sử</button>
          ${p.debt ? html`<button class="btn btn-sm btn-primary" data-pay="${p.id}">${k.payLabel}</button>` : ''}
        </td></tr>`)}
      </tbody></table>` : html`<div class="empty">Chưa có ${k.one} phù hợp.</div>`}
  </div>${pager(res.total, state.page, LIMIT)}`);
}

export async function render(root, { name }) {
  state.kind = name;
  state.q = '';
  state.debt = false;
  state.page = 1;
  const k = KINDS[name];
  mount(root, html`
    <div class="page-head"><h1>${k.title}</h1><span class="muted" id="pt-total"></span><span class="spacer"></span><button class="btn btn-primary" id="pt-add">+ Thêm ${k.one}</button></div>
    <div class="toolbar">
      <input type="search" id="pt-q" placeholder="Tìm theo tên, mã, số điện thoại" aria-label="Tìm ${k.one}">
      <label class="check"><input type="checkbox" id="pt-debt"> Chỉ hiện đang có nợ</label>
    </div>
    <div id="pt-table"></div>`);
  await load();
  $('#pt-q', root).addEventListener('input', debounce((e) => { state.q = e.target.value; state.page = 1; load().catch(showError); }));
  $('#pt-debt', root).addEventListener('change', (e) => { state.debt = e.target.checked; state.page = 1; load().catch(showError); });
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#pt-add')) return edit(null);
    const page = t.closest('[data-page]');
    if (page) {
      state.page = Number(page.dataset.page);
      return void load().catch(showError);
    }
    const find = (id) => state.rows.find((p) => p.id === Number(id));
    const payBtn = t.closest('[data-pay]');
    if (payBtn) return pay(find(payBtn.dataset.pay));
    const hist = t.closest('[data-history]');
    if (hist) return void history(find(hist.dataset.history)).catch(showError);
    if (t.closest('[data-stop]')) return undefined;
    const row = t.closest('tr[data-id]');
    if (row) edit(find(row.dataset.id));
    return undefined;
  });
}
