import { api, html, mount, raw, $, $$, session, isAdmin, money, qtyFmt, parseMoney, parseQty, toast, showError, openModal, modalOpen, attachSearch, METHOD_LABEL } from '../core.js';
import { setScanHandler, beep, startCameraScan } from '../devices/scanner.js';
import { getConfig, printInvoice } from '../devices/printer.js';

const STORE_KEY = 'pos.tabs.v1';

const newRef = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const newTab = (n) => ({
  id: newRef(), label: `Hóa đơn ${n}`, n, items: [], customer: null, discount: 0, discountType: 'vnd',
  method: 'cash', paid: null, note: '', client_ref: newRef(),
});

const state = { tabs: [], active: 0, products: [], categories: [], categoryId: '', busy: false, print: true };

function loadTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved?.tabs?.length) {
      state.tabs = saved.tabs;
      state.active = Math.min(saved.active ?? 0, saved.tabs.length - 1);
      return;
    }
  } catch { /* dữ liệu hỏng thì tạo mới */ }
  state.tabs = [newTab(1)];
  state.active = 0;
}
const persist = () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ tabs: state.tabs, active: state.active }));
  } catch { /* bộ nhớ đầy: hóa đơn vẫn chạy trong phiên này */ }
};
const tab = () => state.tabs[state.active];

function totals(t = tab()) {
  const subtotal = t.items.reduce((s, i) => s + Math.max(Math.round(i.qty * i.price) - (i.discount || 0), 0), 0);
  const discount = t.discountType === 'pct'
    ? Math.round((subtotal * Math.min(t.discount, 100)) / 100)
    : Math.min(t.discount, subtotal);
  const rate = Number(session.settings.business.tax_rate) || 0;
  const tax = Math.round(((subtotal - discount) * rate) / 100);
  const total = subtotal - discount + tax;
  const paid = t.paid === null ? total : t.paid;
  return { subtotal, discount, rate, tax, total, paid, change: Math.max(paid - total, 0), debt: Math.max(total - paid, 0) };
}

function addProduct(p, qty = 1) {
  const t = tab();
  t.paid = null; // tổng tiền đổi thì số tiền khách đưa quay về mặc định, tránh ghi nợ nhầm
  const existing = t.items.find((i) => i.product_id === p.id);
  if (existing) {
    existing.qty = Math.round((existing.qty + qty) * 1000) / 1000;
    // Đưa dòng vừa quét lên đầu để thu ngân thấy ngay.
    t.items.splice(t.items.indexOf(existing), 1);
    t.items.unshift(existing);
  } else {
    t.items.unshift({
      product_id: p.id, code: p.code, name: p.name, unit: p.unit, qty, price: p.sale_price, list_price: p.sale_price, discount: 0,
      stock: p.track_stock ? p.stock : null,
    });
  }
  renderCart(true);
  renderPanel();
  persist();
}

async function onScan(code) {
  try {
    const p = await api('/products/lookup', { query: { code } });
    addProduct(p);
    beep(true);
  } catch (err) {
    beep(false);
    showError(err);
  }
}

function renderTabs() {
  mount($('#pos-tabs'), html`
    ${state.tabs.map((t, i) => html`
      <button class="pos-tab ${i === state.active ? 'active' : ''}" data-tab="${i}">
        ${t.label}${t.items.length ? ` (${t.items.length})` : ''}
        <span class="x" data-close-tab="${i}" title="Đóng hóa đơn" aria-label="Đóng ${t.label}">×</span>
      </button>`)}
    <button class="pos-add" id="pos-add-tab" title="Hóa đơn mới (F8)" aria-label="Hóa đơn mới">+</button>`);
}

function renderCart(flashFirst = false) {
  const t = tab();
  const canEditPrice = isAdmin() || session.settings.business.cashier_can_edit_price;
  const box = $('#pos-cart');
  if (!t.items.length) {
    mount(box, html`<div class="pos-empty">
      <strong>Chưa có hàng trong hóa đơn</strong>
      <span>Quét mã vạch, gõ tên hàng ở ô tìm kiếm (F2), hoặc chọn hàng bên dưới.</span>
    </div>`);
    return;
  }
  mount(box, html`<table>
    <thead><tr><th style="width:34px">#</th><th>Hàng hóa</th><th>Số lượng</th><th class="num">Đơn giá</th><th class="num hide-sm">Giảm giá</th><th class="num">Thành tiền</th><th style="width:34px"></th></tr></thead>
    <tbody>
    ${t.items.map((it, i) => {
    const over = it.stock !== null && it.stock !== undefined && it.qty > it.stock;
    return html`<tr class="${flashFirst && i === 0 ? 'flash' : ''}" data-row="${i}">
        <td class="muted">${t.items.length - i}</td>
        <td><div class="pname">${it.name}</div><div class="small muted">${it.code} · ${it.unit}${over ? html` · <span class="bad">Tồn ${qtyFmt(it.stock)}</span>` : ''}</div></td>
        <td><div class="qty-box">
          <button type="button" data-act="dec" aria-label="Giảm số lượng">−</button>
          <input data-field="qty" value="${it.qty}" inputmode="decimal" aria-label="Số lượng ${it.name}">
          <button type="button" data-act="inc" aria-label="Tăng số lượng">+</button>
        </div></td>
        <td class="num" style="width:110px"><input class="money" data-field="price" value="${money(it.price)}" inputmode="numeric" aria-label="Đơn giá ${it.name}" ${canEditPrice ? '' : raw('readonly tabindex="-1"')}></td>
        <td class="num hide-sm" style="width:96px"><input class="money" data-field="discount" value="${money(it.discount)}" inputmode="numeric" aria-label="Giảm giá ${it.name}"></td>
        <td class="num strong" data-line-total>${money(Math.round(it.qty * it.price) - it.discount)}</td>
        <td><button type="button" class="icon-btn" data-act="remove" aria-label="Xóa ${it.name}">×</button></td>
      </tr>`;
  })}
    </tbody></table>`);
}

function renderPanel() {
  const t = tab();
  const x = totals(t);
  const box = $('#pos-panel');
  const quick = [...new Set([x.total, ...[10000, 20000, 50000, 100000, 200000, 500000].map((d) => Math.ceil(x.total / d) * d)])]
    .filter((v) => v >= x.total && v > 0).sort((a, b) => a - b).slice(0, 6);
  mount(box, html`
    <div class="pos-customer">
      ${t.customer ? html`<div class="pos-chip">
          <div><strong>${t.customer.name}</strong><small>${t.customer.phone || t.customer.code}${t.customer.debt ? ` · Đang nợ ${money(t.customer.debt)}` : ''}</small></div>
          <button type="button" class="icon-btn" id="pos-clear-customer" aria-label="Bỏ chọn khách">×</button>
        </div>` : html`<div><input id="pos-customer-input" placeholder="Tìm khách hàng (F3)" aria-label="Tìm khách hàng"></div>
        <button type="button" class="btn" id="pos-new-customer" title="Thêm khách hàng mới" aria-label="Thêm khách hàng mới">+</button>`}
    </div>
    <div class="pos-line"><span>Tiền hàng</span><span class="num">${money(x.subtotal)}</span></div>
    <div class="pos-line"><span>Giảm giá</span>
      <div class="ctl">
        <input id="pos-discount" class="${t.discountType === 'vnd' ? 'money' : ''}" value="${t.discountType === 'vnd' ? money(t.discount) : t.discount}" inputmode="numeric" aria-label="Giảm giá hóa đơn" style="text-align:right">
        <select id="pos-discount-type" aria-label="Đơn vị giảm giá">
          <option value="vnd" ${t.discountType === 'vnd' ? raw('selected') : ''}>đ</option>
          <option value="pct" ${t.discountType === 'pct' ? raw('selected') : ''}>%</option>
        </select>
      </div>
    </div>
    ${x.tax ? html`<div class="pos-line"><span>Thuế GTGT ${x.rate}%</span><span class="num">${money(x.tax)}</span></div>` : ''}
    <div class="pos-total"><span class="strong">Khách phải trả</span><b id="pos-total">${money(x.total)}</b></div>
    <div class="seg" role="group" aria-label="Hình thức thanh toán">
      ${Object.entries(METHOD_LABEL).map(([k, v]) => html`<button type="button" data-method="${k}" class="${t.method === k ? 'active' : ''}">${v}</button>`)}
    </div>
    <div class="pos-line"><span>Khách đưa (F4)</span><div class="ctl"><input id="pos-paid" class="money" value="${money(x.paid)}" inputmode="numeric" aria-label="Số tiền khách đưa"></div></div>
    ${t.method === 'cash' && x.total > 0 ? html`<div class="cash-quick">${quick.map((v) => html`<button type="button" data-cash="${v}">${money(v)}</button>`)}</div>` : ''}
    <div class="pos-line" id="pos-change-line">${changeLine(x)}</div>
    <input id="pos-note" placeholder="Ghi chú hóa đơn" value="${t.note}" aria-label="Ghi chú hóa đơn">
    <label class="check"><input type="checkbox" id="pos-print" ${state.print ? raw('checked') : ''}> In hóa đơn sau khi thanh toán</label>
    <button type="button" class="pay-btn" id="pos-pay" ${t.items.length && !state.busy ? '' : raw('disabled')}>THANH TOÁN (F9)</button>`);
  if (!t.customer) attachCustomerSearch();
}

function changeLine(x) {
  if (x.debt > 0) return html`<span class="bad strong">Còn nợ</span><span class="num bad strong">${money(x.debt)}</span>`;
  return html`<span>Tiền thừa trả khách</span><span class="num strong">${money(x.change)}</span>`;
}

function refreshNumbers() {
  const x = totals();
  $('#pos-total').textContent = money(x.total);
  mount($('#pos-change-line'), changeLine(x));
}

function attachCustomerSearch() {
  attachSearch($('#pos-customer-input'), {
    search: async (q) => (await api('/customers', { query: { q, limit: 8 } })).rows,
    renderItem: (c) => html`<span><strong>${c.name}</strong><br><small class="muted">${c.phone || c.code}</small></span>${c.debt ? html`<span class="small bad">Nợ ${money(c.debt)}</span>` : ''}`,
    onPick: (c) => {
      tab().customer = { id: c.id, name: c.name, code: c.code, phone: c.phone, debt: c.debt };
      renderPanel();
      persist();
    },
  });
}

function renderProducts() {
  mount($('#pos-cats'), html`
    <button data-cat="" class="${state.categoryId === '' ? 'active' : ''}">Tất cả</button>
    ${state.categories.map((c) => html`<button data-cat="${c.id}" class="${String(state.categoryId) === String(c.id) ? 'active' : ''}">${c.name}</button>`)}`);
  mount($('#pos-grid'), state.products.length
    ? state.products.map((p) => html`<button type="button" class="pos-item" data-product="${p.id}">
        <span class="n">${p.name}</span>
        <span class="p"><b>${money(p.sale_price)}</b>${p.track_stock ? html`<span class="${p.stock <= 0 ? 'out' : ''}">Tồn ${qtyFmt(p.stock)}</span>` : ''}</span>
      </button>`)
    : html`<div class="muted small">Chưa có hàng hóa trong nhóm này.</div>`);
}

async function loadProducts() {
  const res = await api('/products', { query: { category_id: state.categoryId, limit: 60 } });
  state.products = res.rows;
  renderProducts();
}

function closeTab(i) {
  const t = state.tabs[i];
  const doClose = () => {
    state.tabs.splice(i, 1);
    if (!state.tabs.length) state.tabs.push(newTab(1));
    state.active = Math.min(state.active, state.tabs.length - 1);
    renderAll();
    persist();
  };
  if (!t.items.length) return doClose();
  openModal({
    title: `Đóng ${t.label}?`,
    body: html`<p>Hóa đơn có ${t.items.length} mặt hàng chưa thanh toán sẽ bị bỏ.</p>`,
    submitLabel: 'Đóng hóa đơn',
    onSubmit: doClose,
  });
  return undefined;
}

function addTab() {
  const n = Math.max(0, ...state.tabs.map((t) => t.n)) + 1;
  state.tabs.push(newTab(n));
  state.active = state.tabs.length - 1;
  renderAll();
  persist();
  $('#pos-search').focus();
}

function renderAll() {
  renderTabs();
  renderCart();
  renderPanel();
}

async function pay() {
  const t = tab();
  if (!t.items.length || state.busy) return;
  const x = totals(t);
  if (x.debt > 0 && !t.customer) {
    showError(new Error('Khách trả thiếu: chọn khách hàng để ghi nợ, hoặc nhập đủ tiền'));
    return;
  }
  state.busy = true;
  $('#pos-pay').disabled = true;
  try {
    const invoice = await api('/invoices', {
      method: 'POST',
      body: {
        client_ref: t.client_ref,
        customer_id: t.customer?.id,
        items: t.items.map((i) => ({ product_id: i.product_id, qty: i.qty, price: i.price, discount: i.discount })),
        discount: x.discount,
        method: t.method,
        paid: x.paid,
        note: t.note,
      },
    });
    // Reset hóa đơn trước khi in: lỗi máy in không được làm thu ngân tính tiền lại lần nữa.
    const idx = state.tabs.indexOf(t);
    state.tabs[idx] = newTab(t.n);
    persist();
    renderAll();
    toast(`Đã tạo ${invoice.code}${invoice.change_due ? ` · Trả lại khách ${money(invoice.change_due)}` : ''}`);
    beep(true);
    loadProducts().catch(() => {});
    if (state.print) {
      printInvoice(invoice, { kickDrawer: invoice.method === 'cash' }).catch((err) => {
        openModal({
          title: 'Không in được hóa đơn',
          body: html`<p>Hóa đơn ${invoice.code} đã lưu thành công, chỉ phần in bị lỗi.</p><p class="bad">${err.message}</p><p class="muted">Sửa máy in rồi in lại tại mục Hóa đơn.</p>`,
        });
      });
    }
    $('#pos-search').focus();
  } catch (err) {
    showError(err);
  } finally {
    state.busy = false;
    const btn = $('#pos-pay');
    if (btn) btn.disabled = !tab().items.length;
  }
}

function openCamera() {
  let stop = null;
  let last = '';
  let lastAt = 0;
  const m = openModal({
    title: 'Quét bằng camera',
    body: html`<video class="camera-view" playsinline muted></video><p class="hint" style="margin-top:8px" id="cam-status">Đưa mã vạch vào giữa khung hình.</p>`,
    onMount: async (root) => {
      const obs = new MutationObserver(() => {
        if (!root.isConnected) {
          obs.disconnect();
          stop?.();
        }
      });
      obs.observe(document.body, { childList: true });
      try {
        stop = await startCameraScan($('video', root), (code) => {
          // Cùng một mã nằm yên trước camera sẽ được nhận lặp lại, nên bỏ qua trong 2 giây.
          if (code === last && Date.now() - lastAt < 2000) return;
          last = code;
          lastAt = Date.now();
          onScan(code);
        });
        if (!root.isConnected) stop();
      } catch (err) {
        $('#cam-status', root).textContent = `Không mở được camera: ${err.message}`;
        $('#cam-status', root).classList.add('bad');
      }
    },
  });
  return m;
}

function newCustomerModal() {
  openModal({
    title: 'Thêm khách hàng',
    body: html`<div class="form-grid">
      <label class="field full"><span>Tên khách hàng</span><input name="name" required></label>
      <label class="field"><span>Điện thoại</span><input name="phone" inputmode="tel"></label>
      <label class="field"><span>Địa chỉ</span><input name="address"></label>
    </div>`,
    onSubmit: async (data) => {
      const c = await api('/customers', { method: 'POST', body: data });
      tab().customer = { id: c.id, name: c.name, code: c.code, phone: c.phone, debt: 0 };
      renderPanel();
      persist();
    },
  });
}

export async function render(root) {
  loadTabs();
  state.print = getConfig().autoPrint;
  mount(root, html`
    <div class="pos">
      <header class="pos-top">
        <div class="pos-search">
          <input id="pos-search" placeholder="Tìm hàng theo tên, mã, hoặc quét mã vạch (F2)" aria-label="Tìm hàng hóa">
          <button type="button" class="cam" id="pos-camera" title="Quét bằng camera" aria-label="Quét bằng camera">📷</button>
        </div>
        <div class="pos-tabs" id="pos-tabs"></div>
        <span class="small nowrap hide-sm" title="Máy quét USB hoạt động ngay, không cần chọn ô nhập"><span class="device-dot"></span>Sẵn sàng quét</span>
        <a class="link" href="#/invoices">Hóa đơn</a>
        <a class="link" href="${isAdmin() ? '#/' : '#/invoices'}">Thoát</a>
      </header>
      <div class="pos-body">
        <section class="pos-left">
          <div class="pos-cart" id="pos-cart"></div>
          <div class="pos-grid-wrap">
            <div class="pos-cats" id="pos-cats"></div>
            <div class="pos-grid" id="pos-grid"></div>
          </div>
        </section>
        <aside class="pos-panel" id="pos-panel"></aside>
      </div>
    </div>`);
  renderAll();

  attachSearch($('#pos-search'), {
    search: async (q) => (await api('/products', { query: { q, limit: 12 } })).rows,
    renderItem: (p) => html`<span><strong>${p.name}</strong><br><small class="muted">${p.code}${p.barcode ? ` · ${p.barcode}` : ''}</small></span>
      <span class="num"><strong>${money(p.sale_price)}</strong><br><small class="${p.track_stock && p.stock <= 0 ? 'bad' : 'muted'}">${p.track_stock ? `Tồn ${qtyFmt(p.stock)}` : 'Dịch vụ'}</small></span>`,
    onPick: (p) => {
      addProduct(p);
      const input = $('#pos-search');
      input.value = '';
      input.focus();
    },
  });

  const top = root.querySelector('.pos');
  top.addEventListener('click', (e) => {
    const t = e.target;
    const closeBtn = t.closest('[data-close-tab]');
    if (closeBtn) return closeTab(Number(closeBtn.dataset.closeTab));
    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) {
      state.active = Number(tabBtn.dataset.tab);
      renderAll();
      persist();
      return undefined;
    }
    if (t.closest('#pos-add-tab')) return addTab();
    if (t.closest('#pos-camera')) return openCamera();
    if (t.closest('#pos-pay')) return pay();
    if (t.closest('#pos-new-customer')) return newCustomerModal();
    if (t.closest('#pos-clear-customer')) {
      tab().customer = null;
      renderPanel();
      persist();
      return undefined;
    }
    const product = t.closest('[data-product]');
    if (product) {
      const p = state.products.find((x) => x.id === Number(product.dataset.product));
      if (p) addProduct(p);
      return undefined;
    }
    const cat = t.closest('[data-cat]');
    if (cat) {
      state.categoryId = cat.dataset.cat;
      loadProducts().catch(showError);
      return undefined;
    }
    const method = t.closest('[data-method]');
    if (method) {
      tab().method = method.dataset.method;
      if (tab().method !== 'cash') tab().paid = null; // chuyển khoản, thẻ mặc định trả đúng số tiền
      renderPanel();
      persist();
      return undefined;
    }
    const cash = t.closest('[data-cash]');
    if (cash) {
      tab().paid = Number(cash.dataset.cash);
      $('#pos-paid').value = money(tab().paid);
      refreshNumbers();
      persist();
      return undefined;
    }
    const act = t.closest('[data-act]');
    if (act) {
      const i = Number(act.closest('[data-row]').dataset.row);
      const item = tab().items[i];
      if (act.dataset.act === 'remove') tab().items.splice(i, 1);
      if (act.dataset.act === 'inc') item.qty = Math.round((item.qty + 1) * 1000) / 1000;
      if (act.dataset.act === 'dec' && item.qty > 1) item.qty = Math.round((item.qty - 1) * 1000) / 1000;
      tab().paid = null;
      renderCart();
      renderTabs();
      renderPanel();
      persist();
    }
    return undefined;
  });

  top.addEventListener('change', (e) => {
    const t = e.target;
    const row = t.closest('[data-row]');
    if (row && t.dataset.field) {
      const item = tab().items[Number(row.dataset.row)];
      if (t.dataset.field === 'qty') {
        const q = parseQty(t.value);
        if (q > 0) item.qty = Math.round(q * 1000) / 1000;
        else showError(new Error('Số lượng phải lớn hơn 0'));
      }
      if (t.dataset.field === 'price') item.price = parseMoney(t.value);
      if (t.dataset.field === 'discount') {
        item.discount = Math.min(parseMoney(t.value), Math.round(item.qty * item.price));
      }
      item.discount = Math.min(item.discount, Math.round(item.qty * item.price));
      tab().paid = null;
      renderCart();
      renderPanel();
      persist();
      return;
    }
    if (t.id === 'pos-discount') {
      const cur = tab();
      cur.discount = cur.discountType === 'pct' ? Math.min(Math.max(parseQty(t.value) || 0, 0), 100) : parseMoney(t.value);
      cur.paid = null;
      renderPanel();
      persist();
    } else if (t.id === 'pos-discount-type') {
      tab().discountType = t.value;
      tab().discount = 0;
      tab().paid = null;
      renderPanel();
      persist();
    } else if (t.id === 'pos-note') {
      tab().note = t.value;
      persist();
    } else if (t.id === 'pos-print') {
      state.print = t.checked;
    }
  });

  top.addEventListener('input', (e) => {
    if (e.target.id === 'pos-paid') {
      tab().paid = parseMoney(e.target.value);
      refreshNumbers();
      persist();
    }
  });

  const onKey = (e) => {
    if (modalOpen()) return;
    const map = {
      F2: () => $('#pos-search').focus(),
      F3: () => $('#pos-customer-input')?.focus(),
      F4: () => $('#pos-paid')?.select(),
      F8: addTab,
      F9: pay,
    };
    if (map[e.key]) {
      e.preventDefault();
      // Ô đang gõ có thể chưa bắn sự kiện change: ép cập nhật trước khi thanh toán.
      document.activeElement?.blur?.();
      map[e.key]();
    }
  };
  document.addEventListener('keydown', onKey);

  const offScan = setScanHandler(onScan);

  try {
    state.categories = await api('/categories');
    await loadProducts();
  } catch (err) {
    showError(err);
  }
  $('#pos-search')?.focus();

  return () => {
    document.removeEventListener('keydown', onKey);
    offScan();
  };
}
