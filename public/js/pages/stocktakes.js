import { api, html, mount, $, money, qtyFmt, parseQty, toast, showError, openModal, attachSearch, pager, fmtDateTime } from '../core.js';
import { setScanHandler, beep } from '../devices/scanner.js';

const LIMIT = 30;
const state = { page: 1 };

async function load() {
  const box = $('#st-table');
  if (!box) return;
  const res = await api('/stocktakes', { query: { page: state.page, limit: LIMIT } });
  mount(box, html`<div class="table-wrap">
    ${res.rows.length ? html`<table class="data">
      <thead><tr><th>Mã phiếu</th><th>Thời gian</th><th>Người kiểm</th><th class="num">Chênh lệch SL</th><th class="num">Giá trị chênh lệch</th><th>Ghi chú</th></tr></thead>
      <tbody>${res.rows.map((t) => html`<tr class="clickable" data-id="${t.id}">
        <td class="strong">${t.code}</td><td class="nowrap">${fmtDateTime(t.created_at)}</td><td>${t.user_name}</td>
        <td class="num ${t.diff_qty < 0 ? 'bad' : ''}">${qtyFmt(t.diff_qty)}</td><td class="num ${t.diff_value < 0 ? 'bad' : ''}">${t.diff_value < 0 ? '-' : ''}${money(Math.abs(t.diff_value))}</td><td>${t.note}</td></tr>`)}
      </tbody></table>` : html`<div class="empty">Chưa có phiếu kiểm kho.</div>`}
  </div>${pager(res.total, state.page, LIMIT)}`);
}

async function showTake(id) {
  const t = await api(`/stocktakes/${id}`);
  openModal({
    title: `Phiếu kiểm kho ${t.code}`,
    wide: true,
    body: html`<p class="muted">${fmtDateTime(t.created_at)} · ${t.user_name}</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Hàng hóa</th><th class="num">Tồn hệ thống</th><th class="num">Thực tế</th><th class="num">Chênh lệch</th></tr></thead>
      <tbody>${t.items.map((i) => html`<tr><td>${i.name}</td><td class="num">${qtyFmt(i.system_qty)}</td><td class="num">${qtyFmt(i.actual_qty)}</td><td class="num ${i.diff_qty < 0 ? 'bad' : i.diff_qty > 0 ? 'good' : ''}">${qtyFmt(i.diff_qty)}</td></tr>`)}</tbody></table></div>`,
  });
}

function createTake() {
  const items = [];
  let root;
  const add = (p) => {
    const hit = items.find((i) => i.product_id === p.id);
    // Quét lại đúng một mã nghĩa là đếm thêm một đơn vị.
    if (hit) hit.actual = Math.round((hit.actual + 1) * 1000) / 1000;
    else items.unshift({ product_id: p.id, name: p.name, code: p.code, unit: p.unit, system: p.stock, actual: 1 });
    paint();
  };
  const paint = () => {
    mount($('#sc-lines', root), items.length ? html`<table class="data">
      <thead><tr><th>Hàng hóa</th><th class="num">Tồn hệ thống</th><th style="width:110px">Thực tế</th><th class="num">Chênh lệch</th><th></th></tr></thead>
      <tbody>${items.map((i, idx) => {
    const diff = Math.round((i.actual - i.system) * 1000) / 1000;
    return html`<tr data-row="${idx}"><td>${i.name}<br><span class="small muted">${i.code}</span></td><td class="num">${qtyFmt(i.system)} ${i.unit}</td>
        <td><input data-actual value="${i.actual}" inputmode="decimal" style="text-align:right" aria-label="Số thực tế ${i.name}"></td>
        <td class="num ${diff < 0 ? 'bad' : diff > 0 ? 'good' : ''}">${diff > 0 ? '+' : ''}${qtyFmt(diff)}</td>
        <td><button type="button" class="icon-btn" data-rm aria-label="Xóa ${i.name}">×</button></td></tr>`;
  })}</tbody></table>` : html`<div class="empty">Quét từng sản phẩm để đếm: mỗi lần quét cộng thêm 1.</div>`);
  };
  const off = setScanHandler(async (code) => {
    try {
      const p = await api('/products/lookup', { query: { code } });
      if (!p.track_stock) throw new Error(`"${p.name}" là dịch vụ, không kiểm kho`);
      add(p);
      beep(true);
    } catch (err) {
      beep(false);
      showError(err);
    }
  });
  openModal({
    title: 'Tạo phiếu kiểm kho',
    wide: true,
    submitLabel: 'Cân bằng kho',
    body: html`
      <div class="form-grid" style="margin-bottom:12px">
        <div class="field"><span>Thêm hàng</span><div><input id="sc-search" placeholder="Tìm tên, mã, hoặc quét mã vạch"></div></div>
        <label class="field"><span>Ghi chú</span><input name="note"></label>
      </div>
      <div class="table-wrap" id="sc-lines"></div>`,
    onMount: (r) => {
      root = r;
      paint();
      attachSearch($('#sc-search', r), {
        search: async (q) => (await api('/products', { query: { q, limit: 10 } })).rows.filter((p) => p.track_stock),
        renderItem: (p) => html`<span>${p.name}</span><span class="small muted">Tồn ${qtyFmt(p.stock)}</span>`,
        onPick: (p) => {
          add(p);
          $('#sc-search', r).value = '';
        },
      });
      r.addEventListener('click', (e) => {
        if (e.target.closest('[data-rm]')) {
          items.splice(Number(e.target.closest('[data-row]').dataset.row), 1);
          paint();
        }
      });
      r.addEventListener('change', (e) => {
        if (!e.target.hasAttribute('data-actual')) return;
        const v = parseQty(e.target.value);
        if (Number.isFinite(v) && v >= 0) items[Number(e.target.closest('[data-row]').dataset.row)].actual = v;
        paint();
      });
      const obs = new MutationObserver(() => {
        if (!r.isConnected) {
          obs.disconnect();
          off();
        }
      });
      obs.observe(document.body, { childList: true });
    },
    onSubmit: async (data) => {
      await api('/stocktakes', { method: 'POST', body: { note: data.note, items: items.map((i) => ({ product_id: i.product_id, actual_qty: i.actual })) } });
      toast('Đã cân bằng kho');
      load();
    },
  });
}

export async function render(root) {
  state.page = 1;
  mount(root, html`
    <div class="page-head"><h1>Kiểm kho</h1><span class="spacer"></span><button class="btn btn-primary" id="st-add">+ Tạo phiếu kiểm</button></div>
    <div id="st-table"></div>`);
  await load();
  root.addEventListener('click', (e) => {
    if (e.target.closest('#st-add')) return createTake();
    const page = e.target.closest('[data-page]');
    if (page) {
      state.page = Number(page.dataset.page);
      return void load().catch(showError);
    }
    const row = e.target.closest('tr[data-id]');
    if (row) showTake(row.dataset.id).catch(showError);
    return undefined;
  });
}
