import { api, html, mount, raw, $, $$, isAdmin, money, qtyFmt, toast, showError, openModal, confirmBox, debounce, pager, downloadCsv, parseCsv, fmtDateTime } from '../core.js';
import { setScanHandler, beep } from '../devices/scanner.js';
import { code128Svg } from '../devices/barcode.js';
import { printHtml } from '../devices/printer.js';

const LIMIT = 30;
const MOVE_LABEL = {
  opening: 'Tồn đầu kỳ', sale: 'Bán hàng', sale_cancel: 'Hủy hóa đơn', return: 'Khách trả hàng',
  purchase: 'Nhập hàng', purchase_cancel: 'Hủy phiếu nhập', stocktake: 'Kiểm kho',
};
const state = { q: '', category_id: '', low: false, page: 1, categories: [], rows: [] };

function productForm(p = {}) {
  const isNew = !p.id;
  return html`<div class="form-grid">
    <label class="field full"><span>Tên hàng</span><input name="name" value="${p.name ?? ''}" required></label>
    <label class="field"><span>Mã hàng (bỏ trống để tự sinh)</span><input name="code" value="${p.code ?? ''}"></label>
    <label class="field"><span>Mã vạch (quét vào đây)</span><input name="barcode" id="pf-barcode" value="${p.barcode ?? ''}"></label>
    <label class="field"><span>Nhóm hàng</span><select name="category_id"><option value="">Chưa phân nhóm</option>
      ${state.categories.map((c) => html`<option value="${c.id}" ${c.id === p.category_id ? raw('selected') : ''}>${c.name}</option>`)}</select></label>
    <label class="field"><span>Đơn vị tính</span><input name="unit" value="${p.unit ?? 'cái'}"></label>
    <label class="field"><span>Giá vốn</span><input class="money" name="cost_price" value="${money(p.cost_price ?? 0)}" inputmode="numeric"></label>
    <label class="field"><span>Giá bán</span><input class="money" name="sale_price" value="${money(p.sale_price ?? 0)}" inputmode="numeric"></label>
    ${isNew ? html`<label class="field"><span>Tồn đầu kỳ</span><input name="stock" value="0" inputmode="decimal"></label>` : html`
      <div class="field"><span>Tồn kho hiện tại</span><div style="padding:6px 0"><strong>${qtyFmt(p.stock)}</strong> <span class="small muted">· đổi tồn bằng phiếu Kiểm kho</span></div></div>`}
    <label class="field"><span>Tồn tối thiểu (cảnh báo)</span><input name="min_stock" value="${p.min_stock ?? 0}" inputmode="decimal"></label>
    ${isNew ? html`<label class="check full"><input type="checkbox" name="service"> Đây là dịch vụ (không theo dõi tồn kho)</label>` : ''}
  </div>`;
}

function editProduct(p) {
  const isNew = !p?.id;
  const off = setScanHandler((code) => {
    const input = $('#pf-barcode');
    if (input) input.value = code;
    beep(true);
  });
  const m = openModal({
    title: isNew ? 'Thêm hàng hóa' : `Sửa ${p.name}`,
    body: productForm(p ?? {}),
    footer: isNew ? '' : html`<button type="button" class="btn btn-danger" id="pf-delete">Ngừng kinh doanh</button>`,
    onMount: (root) => {
      $('#pf-delete', root)?.addEventListener('click', async () => {
        if (!(await confirmBox('Ngừng kinh doanh', `Ẩn "${p.name}" khỏi danh sách? Hóa đơn cũ vẫn giữ nguyên.`))) return;
        await api(`/products/${p.id}`, { method: 'DELETE' });
        m.close();
        load();
      });
      const obs = new MutationObserver(() => {
        if (!root.isConnected) {
          obs.disconnect();
          off();
          if (location.hash.startsWith('#/products')) setScanHandler(onListScan);
        }
      });
      obs.observe(document.body, { childList: true });
    },
    onSubmit: async (data) => {
      const body = { ...data, min_stock: Number(data.min_stock) || 0, category_id: data.category_id || null };
      if (isNew) {
        body.track_stock = !data.service;
        body.stock = Number(data.stock) || 0;
        await api('/products', { method: 'POST', body });
      } else {
        await api(`/products/${p.id}`, { method: 'PUT', body });
      }
      toast('Đã lưu hàng hóa');
      load();
    },
  });
}

async function showMoves(p) {
  const moves = await api(`/products/${p.id}/moves`);
  openModal({
    title: `Thẻ kho: ${p.name}`,
    wide: true,
    body: moves.length ? html`<div class="table-wrap"><table class="data">
      <thead><tr><th>Thời gian</th><th>Loại</th><th>Chứng từ</th><th class="num">Thay đổi</th><th class="num">Tồn sau</th><th class="num">Giá vốn</th><th>Người thực hiện</th></tr></thead>
      <tbody>${moves.map((m) => html`<tr>
        <td class="nowrap">${fmtDateTime(m.created_at)}</td><td>${MOVE_LABEL[m.type] ?? m.type}</td><td>${m.ref_code}</td>
        <td class="num ${m.qty < 0 ? 'bad' : 'good'}">${m.qty > 0 ? '+' : ''}${qtyFmt(m.qty)}</td>
        <td class="num">${qtyFmt(m.stock_after)}</td><td class="num">${money(m.cost_price)}</td><td>${m.user_name ?? ''}</td></tr>`)}</tbody>
    </table></div>` : html`<p class="muted">Chưa có biến động kho.</p>`,
  });
}

function labelModal(products) {
  openModal({
    title: 'In tem mã vạch',
    wide: true,
    submitLabel: 'In tem',
    body: html`
      <div class="form-grid" style="margin-bottom:12px">
        <label class="field"><span>Khổ tem</span><select name="size">
          <option value="50x30">50 × 30 mm</option><option value="40x30">40 × 30 mm</option><option value="35x22">35 × 22 mm</option>
        </select></label>
        <label class="check" style="align-self:end;padding-bottom:8px"><input type="checkbox" name="show_price" checked> In giá bán trên tem</label>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Hàng hóa</th><th>Mã in</th><th class="num">Giá bán</th><th class="num" style="width:90px">Số tem</th></tr></thead>
        <tbody>${products.map((p) => html`<tr><td>${p.name}</td><td>${p.barcode || p.code}</td><td class="num">${money(p.sale_price)}</td>
          <td><input data-label-id="${p.id}" type="number" min="0" max="500" value="1" style="text-align:right"></td></tr>`)}</tbody>
      </table></div>`,
    onSubmit: async (data, form) => {
      const [w, h] = data.size.split('x').map(Number);
      const labels = [];
      for (const p of products) {
        const n = Math.min(Math.max(Number($(`[data-label-id="${p.id}"]`, form).value) || 0, 0), 500);
        const code = p.barcode || p.code;
        let bars;
        try {
          bars = code128Svg(code, { height: 30 });
        } catch {
          throw new Error(`Mã "${code}" của ${p.name} có ký tự không in được trên mã vạch`);
        }
        for (let i = 0; i < n; i += 1) labels.push({ name: p.name, code, bars, price: p.sale_price });
      }
      if (!labels.length) throw new Error('Chưa nhập số tem cần in');
      const safe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      printHtml(`<!doctype html><html><head><meta charset="utf-8"><style>
        @page { size: ${w}mm ${h}mm; margin: 0; }
        * { box-sizing: border-box; }
        body { margin: 0; font-family: Arial, sans-serif; color: #000; }
        .l { width: ${w}mm; height: ${h}mm; padding: 1mm 2mm; page-break-after: always; display: flex; flex-direction: column; justify-content: center; text-align: center; overflow: hidden; }
        .n { font-size: 9px; line-height: 1.15; max-height: 2.3em; overflow: hidden; }
        svg { width: 100%; height: ${Math.round(h * 0.42)}mm; display: block; margin: .5mm 0; }
        .c { font-size: 8px; }
        .p { font-size: 11px; font-weight: 700; }
      </style></head><body>${labels.map((l) => `<div class="l"><div class="n">${safe(l.name)}</div>${l.bars}<div class="c">${safe(l.code)}</div>${data.show_price ? `<div class="p">${money(l.price)} đ</div>` : ''}</div>`).join('')}</body></html>`);
    },
  });
}

function importModal() {
  openModal({
    title: 'Nhập hàng hóa từ file CSV',
    submitLabel: 'Nhập dữ liệu',
    body: html`
      <p class="hint">Dòng đầu là tiêu đề, gồm các cột: <strong>code, barcode, name, category, unit, cost_price, sale_price, stock, min_stock</strong>. Mã đã có sẽ được cập nhật thông tin (không đổi tồn kho). Mã mới sẽ được tạo cùng tồn đầu kỳ. File Excel: chọn Lưu thành "CSV UTF-8".</p>
      <label class="field"><span>Chọn file .csv</span><input type="file" name="file" accept=".csv,text/csv"></label>`,
    onSubmit: async (_, form) => {
      const file = form.elements.file.files[0];
      if (!file) throw new Error('Chưa chọn file');
      const rows = parseCsv(await file.text()).map((r) => ({
        ...r,
        cost_price: Number(String(r.cost_price ?? '').replace(/[^\d]/g, '')) || 0,
        sale_price: Number(String(r.sale_price ?? '').replace(/[^\d]/g, '')) || 0,
        stock: Number(r.stock) || 0,
        min_stock: Number(r.min_stock) || 0,
      }));
      const res = await api('/products/import', { method: 'POST', body: { rows } });
      toast(`Đã tạo ${res.created}, cập nhật ${res.updated} hàng hóa`);
      state.categories = await api('/categories');
      load();
    },
  });
}

async function exportCsv() {
  const res = await api('/products', { query: { limit: 1000 } });
  downloadCsv('hang-hoa.csv',
    ['code', 'barcode', 'name', 'category', 'unit', 'cost_price', 'sale_price', 'stock', 'min_stock'],
    res.rows.map((p) => [p.code, p.barcode, p.name, p.category_name, p.unit, p.cost_price ?? '', p.sale_price, p.stock, p.min_stock]));
}

function categoriesModal() {
  openModal({
    title: 'Nhóm hàng',
    submitLabel: 'Thêm nhóm',
    body: html`
      <label class="field" style="margin-bottom:12px"><span>Tên nhóm mới</span><input name="name"></label>
      <div id="cat-list">${state.categories.map((c) => html`<div class="kv"><span>${c.name} <span class="small muted">(${c.product_count})</span></span>
        <button type="button" class="btn btn-sm btn-danger" data-del-cat="${c.id}">Xóa</button></div>`)}</div>`,
    onMount: (root) => root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del-cat]');
      if (!b) return;
      await api(`/categories/${b.dataset.delCat}`, { method: 'DELETE' }).catch(showError);
      state.categories = await api('/categories');
      b.closest('.kv').remove();
      paintFilters();
    }),
    onSubmit: async (data) => {
      await api('/categories', { method: 'POST', body: data });
      state.categories = await api('/categories');
      paintFilters();
    },
  });
}

function paintFilters() {
  const sel = $('#pd-cat');
  if (sel) mount(sel, html`<option value="">Tất cả nhóm</option>${state.categories.map((c) => html`<option value="${c.id}" ${String(c.id) === String(state.category_id) ? raw('selected') : ''}>${c.name}</option>`)}`);
}

async function load() {
  const box = $('#pd-table');
  if (!box) return;
  const res = await api('/products', { query: { q: state.q, category_id: state.category_id, low: state.low ? 1 : '', page: state.page, limit: LIMIT } });
  state.rows = res.rows;
  const admin = isAdmin();
  mount(box, html`
    <div class="table-wrap">
      ${res.rows.length ? html`<table class="data">
        <thead><tr>
          ${admin ? html`<th style="width:30px"><input type="checkbox" id="pd-all" aria-label="Chọn tất cả"></th>` : ''}
          <th>Mã hàng</th><th>Tên hàng</th><th class="hide-sm">Nhóm</th>
          ${admin ? html`<th class="num">Giá vốn</th>` : ''}<th class="num">Giá bán</th><th class="num">Tồn kho</th>
          ${admin ? html`<th></th>` : ''}
        </tr></thead>
        <tbody>${res.rows.map((p) => html`<tr class="${admin ? 'clickable' : ''}" data-id="${p.id}">
          ${admin ? html`<td data-stop><input type="checkbox" data-sel="${p.id}" aria-label="Chọn ${p.name}"></td>` : ''}
          <td class="nowrap">${p.code}<br><span class="small muted">${p.barcode ?? ''}</span></td>
          <td>${p.name}</td><td class="hide-sm muted">${p.category_name ?? ''}</td>
          ${admin ? html`<td class="num">${money(p.cost_price)}</td>` : ''}
          <td class="num">${money(p.sale_price)}</td>
          <td class="num ${p.track_stock && p.stock <= p.min_stock ? 'bad strong' : ''}">${p.track_stock ? `${qtyFmt(p.stock)} ${p.unit}` : 'Dịch vụ'}</td>
          ${admin ? html`<td class="num" data-stop><button class="btn btn-sm" data-moves="${p.id}">Thẻ kho</button></td>` : ''}
        </tr>`)}</tbody></table>` : html`<div class="empty">Không có hàng hóa phù hợp.</div>`}
    </div>
    ${pager(res.total, state.page, LIMIT)}`);
}

async function onListScan(code) {
  try {
    const p = await api('/products/lookup', { query: { code } });
    beep(true);
    if (isAdmin()) {
      const full = (await api('/products', { query: { q: p.code, limit: 1 } })).rows[0] ?? p;
      editProduct(full);
    } else {
      toast(`${p.name}: ${money(p.sale_price)} đ, tồn ${qtyFmt(p.stock)}`);
    }
  } catch (err) {
    beep(false);
    if (err.status === 404 && isAdmin()) {
      openModal({
        title: 'Mã vạch chưa có trong hệ thống',
        body: html`<p>Tạo hàng hóa mới với mã vạch <strong>${code}</strong>?</p>`,
        submitLabel: 'Tạo hàng hóa',
        onSubmit: () => { setTimeout(() => editProduct({ barcode: code }), 0); },
      });
    } else showError(err);
  }
}

export async function render(root) {
  state.page = 1;
  setScanHandler(onListScan); // đặt trước mọi await để không đè handler của trang kế tiếp
  state.categories = await api('/categories');
  const admin = isAdmin();
  mount(root, html`
    <div class="page-head"><h1>Hàng hóa</h1><span class="spacer"></span>
      ${admin ? html`
        <button class="btn" id="pd-cats">Nhóm hàng</button>
        <button class="btn" id="pd-labels">In tem đã chọn</button>
        <button class="btn" id="pd-import">Nhập CSV</button>
        <button class="btn" id="pd-export">Xuất CSV</button>
        <button class="btn btn-primary" id="pd-add">+ Thêm hàng</button>` : ''}
    </div>
    <div class="toolbar">
      <input type="search" id="pd-q" placeholder="Tìm theo tên, mã, mã vạch (có thể gõ không dấu)" aria-label="Tìm hàng hóa">
      <select id="pd-cat" aria-label="Lọc theo nhóm"></select>
      <label class="check"><input type="checkbox" id="pd-low"> Sắp hết hàng</label>
    </div>
    <div id="pd-table"></div>`);
  paintFilters();
  await load();

  $('#pd-q', root).addEventListener('input', debounce((e) => { state.q = e.target.value; state.page = 1; load().catch(showError); }));
  $('#pd-cat', root).addEventListener('change', (e) => { state.category_id = e.target.value; state.page = 1; load().catch(showError); });
  $('#pd-low', root).addEventListener('change', (e) => { state.low = e.target.checked; state.page = 1; load().catch(showError); });
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#pd-add')) return editProduct(null);
    if (t.closest('#pd-import')) return importModal();
    if (t.closest('#pd-export')) return void exportCsv().catch(showError);
    if (t.closest('#pd-cats')) return categoriesModal();
    if (t.closest('#pd-labels')) {
      const ids = $$('[data-sel]:checked', root).map((x) => Number(x.dataset.sel));
      const picks = state.rows.filter((p) => ids.includes(p.id));
      if (!picks.length) return showError(new Error('Hãy tích chọn hàng cần in tem'));
      return labelModal(picks);
    }
    if (t.id === 'pd-all') {
      $$('[data-sel]', root).forEach((x) => { x.checked = t.checked; });
      return undefined;
    }
    const page = t.closest('[data-page]');
    if (page && !page.disabled) {
      state.page = Number(page.dataset.page);
      return void load().catch(showError);
    }
    const moves = t.closest('[data-moves]');
    if (moves) return void showMoves(state.rows.find((p) => p.id === Number(moves.dataset.moves))).catch(showError);
    if (t.closest('[data-stop]')) return undefined;
    const row = t.closest('tr[data-id]');
    if (row && admin) editProduct(state.rows.find((p) => p.id === Number(row.dataset.id)));
    return undefined;
  });
}
