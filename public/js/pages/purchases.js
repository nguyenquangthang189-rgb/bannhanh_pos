import { api, html, mount, raw, $, money, qtyFmt, parseMoney, parseQty, toast, showError, openModal, confirmBox, attachSearch, pager, fmtDateTime, isoDate, daysAgo, downloadCsv, METHOD_LABEL } from '../core.js';
import { setScanHandler, beep } from '../devices/scanner.js';
import { toBase64 } from '../devices/escpos.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2000;
const MIN_IMAGE_SIDE = 1400; // ảnh nhỏ được phóng to để chữ đủ cao cho OCR

const LIMIT = 30;
const state = { from: daysAgo(30), to: isoDate(), page: 1 };

async function load() {
  const box = $('#pu-table');
  if (!box) return;
  const res = await api('/purchases', { query: { from: state.from, to: state.to, page: state.page, limit: LIMIT } });
  mount(box, html`<div class="table-wrap">
    ${res.rows.length ? html`<table class="data">
      <thead><tr><th>Mã phiếu</th><th>Thời gian</th><th>Nhà cung cấp</th><th class="num">Tổng tiền</th><th class="num">Đã trả</th><th class="num">Còn nợ</th><th>Trạng thái</th></tr></thead>
      <tbody>${res.rows.map((p) => html`<tr class="clickable" data-id="${p.id}">
        <td class="strong">${p.code}</td><td class="nowrap">${fmtDateTime(p.created_at)}</td><td>${p.supplier_name ?? 'Không chọn'}</td>
        <td class="num">${money(p.total)}</td><td class="num">${money(p.paid)}</td><td class="num ${p.debt ? 'bad' : ''}">${money(p.debt)}</td>
        <td>${p.status === 'completed' ? html`<span class="badge badge-good">Hoàn thành</span>` : html`<span class="badge badge-bad">Đã hủy</span>`}</td></tr>`)}
      </tbody></table>` : html`<div class="empty">Chưa có phiếu nhập trong khoảng thời gian này.</div>`}
  </div>${pager(res.total, state.page, LIMIT)}`);
}

async function showPurchase(id) {
  const p = await api(`/purchases/${id}`);
  const m = openModal({
    title: `Phiếu nhập ${p.code}`,
    wide: true,
    body: html`
      <p class="muted">${fmtDateTime(p.created_at)} · ${p.user_name} · ${p.supplier_name ?? 'Không chọn nhà cung cấp'}</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Hàng hóa</th><th class="num">Số lượng</th><th class="num">Giá nhập</th><th class="num">Thành tiền</th></tr></thead>
      <tbody>${p.items.map((i) => html`<tr><td>${i.name}</td><td class="num">${qtyFmt(i.qty)} ${i.unit}</td><td class="num">${money(i.cost)}</td><td class="num">${money(i.line_total)}</td></tr>`)}</tbody>
      <tfoot>
        <tr><td colspan="3">Giảm giá</td><td class="num">${money(p.discount)}</td></tr>
        <tr><td colspan="3">Tổng tiền</td><td class="num">${money(p.total)}</td></tr>
        <tr><td colspan="3">Đã trả</td><td class="num">${money(p.paid)}</td></tr>
        <tr><td colspan="3">Còn nợ</td><td class="num">${money(p.debt)}</td></tr>
      </tfoot></table></div>`,
    footer: p.status === 'completed' ? html`<button type="button" class="btn btn-danger" id="pu-cancel">Hủy phiếu nhập</button>` : html`<span class="badge badge-bad">Đã hủy</span>`,
    onMount: (root) => $('#pu-cancel', root)?.addEventListener('click', async () => {
      if (!(await confirmBox('Hủy phiếu nhập', `Hủy ${p.code}? Tồn kho và công nợ sẽ được đảo lại.`, 'Hủy phiếu'))) return;
      try {
        await api(`/purchases/${p.id}/cancel`, { method: 'POST' });
        toast('Đã hủy phiếu nhập');
        m.close();
        load();
      } catch (err) {
        showError(err);
      }
    }),
  });
}

/** Dòng đọc từ chứng từ. Dòng chưa có product_id phải được chọn hoặc tạo hàng trước khi lưu phiếu. */
function draftLine(line) {
  const base = { qty: line.qty ?? 0, cost: line.cost ?? 0, source: line };
  if (line.product) {
    const p = line.product;
    return { ...base, product_id: p.id, name: p.name, unit: p.unit, code: p.code };
  }
  return { ...base, name: line.name || line.code || line.barcode, unit: line.unit, code: line.code };
}

function pickProductModal(onPick) {
  const m = openModal({
    title: 'Chọn hàng hóa',
    body: html`<div class="field"><span>Tìm theo tên, mã hoặc mã vạch</span><div><input id="pp-search"></div></div><div style="height:220px"></div>`,
    onMount: (r) => attachSearch($('#pp-search', r), {
      search: async (q) => (await api('/products', { query: { q, limit: 10 } })).rows.filter((p) => p.track_stock),
      renderItem: (p) => html`<span><strong>${p.name}</strong><br><small class="muted">${p.code}</small></span><span class="small muted">Tồn ${qtyFmt(p.stock)}</span>`,
      onPick: (p) => {
        m.close();
        onPick(p);
      },
    }),
  });
}

function newProductModal(item, onCreated) {
  const s = item.source;
  openModal({
    title: 'Tạo hàng hóa mới',
    submitLabel: 'Tạo hàng',
    body: html`<div class="form-grid">
      <label class="field full"><span>Tên hàng</span><input name="name" value="${s.name}" required></label>
      <label class="field"><span>Mã hàng (bỏ trống để tự sinh)</span><input name="code" value="${s.code}"></label>
      <label class="field"><span>Mã vạch</span><input name="barcode" value="${s.barcode}"></label>
      <label class="field"><span>Đơn vị tính</span><input name="unit" value="${s.unit || 'cái'}"></label>
      <label class="field"><span>Giá bán</span><input class="money" name="sale_price" value="${s.sale_price ? money(s.sale_price) : ''}" inputmode="numeric"></label>
      <p class="hint full">Giá vốn sẽ được tính từ giá nhập của phiếu này.</p>
    </div>`,
    onSubmit: async (data) => {
      if (data.sale_price <= 0) throw new Error('Hãy nhập giá bán để hàng không bị bán với giá 0 đồng');
      onCreated(await api('/products', { method: 'POST', body: { ...data, cost_price: 0, stock: 0 } }));
    },
  });
}

function createPurchase(imported = null, imageUrl = null) {
  const draft = {
    items: (imported?.lines ?? []).map(draftLine),
    supplier: imported?.supplier ?? null,
    client_ref: crypto.randomUUID?.() ?? String(Date.now()),
  };
  let root;

  const subtotal = () => draft.items.reduce((s, i) => s + Math.round(i.qty * i.cost), 0);
  const addProduct = (p) => {
    const hit = draft.items.find((i) => i.product_id === p.id);
    if (hit) hit.qty += 1;
    else draft.items.unshift({ product_id: p.id, name: p.name, unit: p.unit, code: p.code, qty: 1, cost: p.cost_price ?? 0 });
    paint();
  };
  const assign = (item, p) => {
    item.product_id = p.id;
    item.name = p.name;
    item.unit = p.unit;
    item.code = p.code;
    paint();
  };
  const sourceNote = (i) => {
    const s = i.source;
    if (!s) return '';
    return html`
      ${i.product_id && s.name && s.name !== i.name ? html`<br><span class="small muted">Trên chứng từ: ${s.name}</span>` : ''}
      ${s.uncertain ? html`<br><span class="badge badge-warn">Khó đọc, hãy đối chiếu với ảnh</span>` : ''}
      ${s.warnings.map((w) => html`<br><span class="small bad">${w}</span>`)}`;
  };
  const unresolvedCell = (i) => html`
    <strong>${i.name}</strong> <span class="badge badge-warn">Chưa có trong danh mục</span>
    ${i.source.candidates.length ? html`<div class="small muted" style="margin-top:4px">Có phải là:</div>` : ''}
    <div class="row-actions">
      ${i.source.candidates.map((c) => html`<button type="button" class="btn btn-sm" data-candidate="${c.id}">${c.name}</button>`)}
      <button type="button" class="btn btn-sm" data-pick>Chọn hàng khác</button>
      <button type="button" class="btn btn-sm btn-primary" data-new-product>Tạo hàng mới</button>
    </div>`;
  const paint = () => {
    mount($('#pc-lines', root), draft.items.length ? html`<table class="data">
      <thead><tr><th>Hàng hóa</th><th style="width:100px">Số lượng</th><th style="width:130px">Giá nhập</th><th class="num">Thành tiền</th><th></th></tr></thead>
      <tbody>${draft.items.map((i, idx) => html`<tr data-row="${idx}">
        <td>${i.product_id ? html`${i.name}<br><span class="small muted">${i.code} · ${i.unit}</span>` : unresolvedCell(i)}${sourceNote(i)}</td>
        <td><input data-f="qty" value="${i.qty || ''}" inputmode="decimal" aria-label="Số lượng ${i.name}" style="text-align:right"></td>
        <td><input data-f="cost" class="money" value="${money(i.cost)}" inputmode="numeric" aria-label="Giá nhập ${i.name}"></td>
        <td class="num">${money(Math.round(i.qty * i.cost))}</td>
        <td><button type="button" class="icon-btn" data-rm aria-label="Xóa ${i.name}">×</button></td></tr>`)}
      </tbody></table>` : html`<div class="empty">Quét mã vạch hoặc tìm hàng để thêm vào phiếu.</div>`);
    summary();
  };
  const summary = () => {
    const sub = subtotal();
    const form = $('form', root);
    const disc = Math.min(parseMoney(form.elements.discount.value), sub);
    const total = sub - disc;
    const paidInput = form.elements.paid;
    if (!paidInput.dataset.touched) paidInput.value = money(total);
    const debt = Math.max(total - parseMoney(paidInput.value), 0);
    const docTotal = imported?.doc_total ?? 0;
    const docDiff = docTotal ? docTotal - (imported.vat ?? 0) - total : 0;
    mount($('#pc-sum', root), html`
      <div class="kv"><span>Tiền hàng</span><span class="num">${money(sub)}</span></div>
      <div class="kv total"><span>Phải trả</span><span class="num">${money(total)}</span></div>
      <div class="kv"><span>Còn nợ nhà cung cấp</span><span class="num ${debt ? 'bad' : ''}">${money(debt)}</span></div>
      ${docTotal ? html`<div class="kv"><span>Tổng trên chứng từ${imported.vat ? ' (gồm thuế)' : ''}</span><span class="num">${money(docTotal)}</span></div>
        ${docDiff ? html`<p class="small bad strong" style="margin-top:6px">Lệch ${money(Math.abs(docDiff))} đ so với chứng từ. Hãy kiểm tra lại các dòng trước khi lưu.</p>`
    : html`<p class="small good strong" style="margin-top:6px">Khớp với tổng trên chứng từ.</p>`}` : ''}`);
  };
  const setSupplier = (s) => {
    draft.supplier = s;
    mount($('#pc-supplier-box', root), html`<div class="pos-chip"><strong>${s.name}</strong></div>`);
  };

  const off = setScanHandler(async (code) => {
    try {
      addProduct(await api('/products/lookup', { query: { code } }));
      beep(true);
    } catch (err) {
      beep(false);
      showError(err);
    }
  });

  openModal({
    title: imported ? 'Duyệt phiếu nhập từ chứng từ' : 'Tạo phiếu nhập hàng',
    wide: true,
    submitLabel: 'Hoàn thành phiếu nhập',
    body: html`
      ${imported ? html`<p class="hint" style="margin-bottom:10px">Phiếu chưa được lưu. Hãy kiểm tra số lượng và giá của từng dòng rồi bấm Hoàn thành.</p>` : ''}
      ${imported?.warnings.map((w) => html`<p class="small bad" style="margin-bottom:8px">${w}</p>`)}
      ${imageUrl ? html`<details open class="doc-image"><summary>Ảnh chứng từ</summary><img src="${imageUrl}" alt="Ảnh chứng từ nhập hàng"></details>` : ''}
      ${imported?.ocr_text ? html`<details class="doc-image"><summary>Chữ đọc được từ ảnh (độ tin cậy ${imported.ocr_confidence}%)</summary><pre class="ocr-text">${imported.ocr_text}</pre></details>` : ''}
      <div class="form-grid" style="margin-bottom:12px">
        <div class="field"><span>Thêm hàng hóa</span><div><input id="pc-search" placeholder="Tìm tên, mã, hoặc quét mã vạch"></div></div>
        <div class="field"><span>Nhà cung cấp</span><div id="pc-supplier-box"><input id="pc-supplier" placeholder="Tìm nhà cung cấp"></div>
          ${imported?.supplier_name && !imported.supplier ? html`<div class="small muted">Trên chứng từ: ${imported.supplier_name}
            <button type="button" class="btn btn-sm" id="pc-new-supplier">Tạo nhà cung cấp này</button></div>` : ''}
        </div>
      </div>
      <div class="table-wrap" id="pc-lines" style="margin-bottom:12px"></div>
      <div class="grid-even">
        <div class="form-grid">
          <label class="field"><span>Giảm giá phiếu</span><input class="money" name="discount" value="${money(imported?.discount ?? 0)}" inputmode="numeric"></label>
          <label class="field"><span>Tiền trả</span><input class="money" name="paid" value="0" inputmode="numeric"></label>
          <label class="field"><span>Hình thức</span><select name="method">${Object.entries(METHOD_LABEL).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
          <label class="field"><span>Ghi chú</span><input name="note" value="${imported?.note ?? ''}"></label>
        </div>
        <div id="pc-sum"></div>
      </div>`,
    onMount: (r) => {
      root = r;
      paint();
      attachSearch($('#pc-search', r), {
        search: async (q) => (await api('/products', { query: { q, limit: 10 } })).rows.filter((p) => p.track_stock),
        renderItem: (p) => html`<span><strong>${p.name}</strong><br><small class="muted">${p.code}</small></span><span class="small muted">Tồn ${qtyFmt(p.stock)}</span>`,
        onPick: (p) => {
          addProduct(p);
          $('#pc-search', r).value = '';
        },
      });
      attachSearch($('#pc-supplier', r), {
        search: async (q) => (await api('/suppliers', { query: { q, limit: 8 } })).rows,
        renderItem: (s) => html`<span>${s.name}</span><span class="small muted">${s.phone ?? ''}</span>`,
        onPick: setSupplier,
      });
      if (draft.supplier) setSupplier(draft.supplier);
      r.addEventListener('click', async (e) => {
        const t = e.target;
        if (t.closest('#pc-new-supplier')) {
          try {
            setSupplier(await api('/suppliers', { method: 'POST', body: { name: imported.supplier_name, phone: imported.supplier_phone } }));
            t.closest('.small').remove();
          } catch (err) {
            showError(err);
          }
          return;
        }
        const row = t.closest('[data-row]');
        if (!row) return;
        const item = draft.items[Number(row.dataset.row)];
        if (t.closest('[data-rm]')) {
          draft.items.splice(Number(row.dataset.row), 1);
          paint();
        } else if (t.closest('[data-candidate]')) {
          assign(item, item.source.candidates.find((c) => c.id === Number(t.closest('[data-candidate]').dataset.candidate)));
        } else if (t.closest('[data-pick]')) {
          pickProductModal((p) => assign(item, p));
        } else if (t.closest('[data-new-product]')) {
          newProductModal(item, (p) => assign(item, p));
        }
      });
      r.addEventListener('change', (e) => {
        const row = e.target.closest('[data-row]');
        if (!row || !e.target.dataset.f) return;
        const item = draft.items[Number(row.dataset.row)];
        if (e.target.dataset.f === 'qty') {
          const q = parseQty(e.target.value);
          if (q > 0) item.qty = q;
        } else item.cost = parseMoney(e.target.value);
        paint();
      });
      r.addEventListener('input', (e) => {
        if (e.target.name === 'paid') e.target.dataset.touched = '1';
        if (e.target.name === 'paid' || e.target.name === 'discount') summary();
      });
      const obs = new MutationObserver(() => {
        if (!r.isConnected) {
          obs.disconnect();
          off();
          if (imageUrl) URL.revokeObjectURL(imageUrl);
        }
      });
      obs.observe(document.body, { childList: true });
    },
    onSubmit: async (data) => {
      const unresolved = draft.items.filter((i) => !i.product_id).length;
      if (unresolved) throw new Error(`Còn ${unresolved} dòng chưa có hàng hóa. Hãy chọn, tạo mới hoặc xóa các dòng đó`);
      const noQty = draft.items.find((i) => !(i.qty > 0));
      if (noQty) throw new Error(`Chưa nhập số lượng cho "${noQty.name}"`);
      await api('/purchases', {
        method: 'POST',
        body: {
          client_ref: draft.client_ref,
          supplier_id: draft.supplier?.id,
          items: draft.items.map((i) => ({ product_id: i.product_id, qty: i.qty, cost: i.cost })),
          discount: data.discount,
          paid: data.paid,
          method: data.method,
          note: data.note,
        },
      });
      toast('Đã nhập hàng, tồn kho và giá vốn đã được cập nhật');
      load();
    },
  });
}

/**
 * Đưa ảnh về cỡ vừa cho OCR và chuyển sang PNG xám; máy chủ xoay thẳng, làm sạch và đọc chữ.
 * createImageBitmap tự xoay ảnh điện thoại theo EXIF.
 */
async function imageToPng(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Không mở được ảnh này. Hãy dùng ảnh JPG hoặc PNG (ảnh HEIC của iPhone cần chuyển sang JPG)');
  }
  const side = Math.max(bitmap.width, bitmap.height);
  const scale = side > MAX_IMAGE_SIDE ? MAX_IMAGE_SIDE / side : side < MIN_IMAGE_SIDE ? Math.min(MIN_IMAGE_SIDE / side, 3) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.filter = 'grayscale(1)';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
}

async function readDocument(file) {
  if (file.type.startsWith('image/')) {
    const blob = await imageToPng(file);
    const data = toBase64(new Uint8Array(await blob.arrayBuffer()));
    const result = await api('/purchases/import/image', { method: 'POST', body: { data } });
    return { result, imageUrl: URL.createObjectURL(blob) };
  }
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('File quá lớn, tối đa 5 MB');
  const data = toBase64(new Uint8Array(await file.arrayBuffer()));
  return { result: await api('/purchases/import/file', { method: 'POST', body: { filename: file.name, data } }), imageUrl: null };
}

function importModal() {
  openModal({
    title: 'Tạo phiếu nhập từ file hoặc ảnh',
    submitLabel: 'Đọc chứng từ',
    body: html`
      <label class="field"><span>Chọn file Excel (.xlsx), .csv, hoặc ảnh hóa đơn nhập</span>
        <input type="file" name="file" accept=".xlsx,.xls,.csv,image/*"></label>
      <div class="hint" style="margin-top:10px">
        <p><strong>Excel/CSV:</strong> cần dòng tiêu đề có cột Tên hàng hoặc Mã hàng, và Số lượng. Nên có thêm Đơn giá. <button type="button" class="btn btn-sm" id="im-template">Tải file mẫu</button></p>
        <p><strong>Ảnh:</strong> đọc chữ ngay trên máy này, không cần Internet. Chụp thẳng, đủ sáng, thấy rõ cả bảng hàng và dòng tiêu đề. Mỗi ảnh mất vài giây.</p>
        <p>Phiếu chỉ được lưu sau khi bạn duyệt từng dòng.</p>
      </div>`,
    onMount: (r) => {
      $('#im-template', r).addEventListener('click', () => downloadCsv('mau-nhap-hang.csv', ['Mã hàng', 'Mã vạch', 'Tên hàng', 'ĐVT', 'Số lượng', 'Đơn giá', 'Thành tiền', 'Giá bán'], []));
    },
    onSubmit: async (_, form) => {
      const file = form.elements.file.files[0];
      if (!file) throw new Error('Chưa chọn file');
      const btn = $('button[type=submit]', form);
      btn.textContent = 'Đang đọc...';
      try {
        const { result, imageUrl } = await readDocument(file);
        // Mở sau khi hộp thoại này đóng, để phím tắt và focus thuộc về màn hình duyệt.
        setTimeout(() => createPurchase(result, imageUrl), 0);
      } finally {
        btn.textContent = 'Đọc chứng từ';
      }
    },
  });
}

export async function render(root) {
  state.page = 1;
  mount(root, html`
    <div class="page-head"><h1>Nhập hàng</h1><span class="spacer"></span>
      <button class="btn" id="pu-import">Từ file Excel hoặc ảnh</button>
      <button class="btn btn-primary" id="pu-add">+ Tạo phiếu nhập</button></div>
    <div class="toolbar">
      <label class="check">Từ <input type="date" id="pu-from" value="${state.from}"></label>
      <label class="check">đến <input type="date" id="pu-to" value="${state.to}"></label>
    </div>
    <div id="pu-table"></div>`);
  await load();
  root.addEventListener('change', (e) => {
    if (e.target.id === 'pu-from') state.from = e.target.value;
    else if (e.target.id === 'pu-to') state.to = e.target.value;
    else return;
    state.page = 1;
    load().catch(showError);
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('#pu-add')) return createPurchase();
    if (e.target.closest('#pu-import')) return importModal();
    const page = e.target.closest('[data-page]');
    if (page) {
      state.page = Number(page.dataset.page);
      return void load().catch(showError);
    }
    const row = e.target.closest('tr[data-id]');
    if (row) showPurchase(row.dataset.id).catch(showError);
    return undefined;
  });
}
