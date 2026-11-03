import { api, html, mount, raw, $, $$, session, isAdmin, toast, showError, openModal, fmtDate } from '../core.js';
import { getConfig, saveConfig, printTest, openCashDrawer, pairSerial, pairUsb, printHtml } from '../devices/printer.js';
import { buildTestReceipt, receiptCanvas } from '../devices/receipt.js';
import { connectSerialScanner, disconnectSerialScanner, serialConnected, serialSupported, onScanEvent, beep } from '../devices/scanner.js';

const state = { tab: 'devices' };
const MODE_HELP = {
  browser: 'In qua driver máy in đã cài trong Windows, dùng hộp thoại in của trình duyệt. Dễ nhất, chạy với mọi máy in. Để bỏ hộp thoại, mở trình duyệt với tham số --kiosk-printing.',
  windows: 'Máy chủ gửi thẳng lệnh ESC/POS tới máy in đã cài trong Windows, không hiện hộp thoại. Phù hợp máy in USB đã cài driver và máy chủ chạy trên chính máy nối máy in.',
  network: 'Máy in có cổng LAN/WiFi: nhập IP tĩnh của máy in, cổng thường là 9100. Máy chủ phải cùng mạng với máy in.',
  serial: 'Máy in nối cổng COM, USB-Serial hoặc Bluetooth (SPP). Cần Chrome hoặc Edge.',
  usb: 'Trình duyệt nói chuyện trực tiếp với máy in USB. Trên Windows cần đổi driver sang WinUSB (bằng công cụ Zadig) nên chỉ dùng khi các cách trên không phù hợp.',
};

function readPrinterForm(root) {
  const form = $('#printer-form', root);
  const e = form.elements;
  return {
    mode: e.mode.value,
    paper: Number(e.paper.value),
    render: e.render.value,
    host: e.host.value.trim(),
    port: Number(e.port.value) || 9100,
    printer: e.printer.value,
    baud: Number(e.baud.value) || 9600,
    copies: Number(e.copies.value) || 1,
    autoPrint: e.autoPrint.checked,
    cut: e.cut.checked,
    drawer: e.drawer.checked,
  };
}

function syncModeFields(root) {
  const mode = $('#printer-form', root).elements.mode.value;
  $$('[data-modes]', root).forEach((el) => { el.hidden = !el.dataset.modes.split(' ').includes(mode); });
  $('#mode-help', root).textContent = MODE_HELP[mode];
}

function paintPreview(root) {
  const cfg = readPrinterForm(root);
  const box = $('#preview-box', root);
  const canvas = receiptCanvas(buildTestReceipt(session.settings), cfg.paper);
  canvas.className = 'receipt-preview';
  canvas.style.width = `${cfg.paper === 58 ? 220 : 300}px`;
  box.replaceChildren(canvas);
}

async function loadPrinters(root, current) {
  const sel = $('#printer-form', root).elements.printer;
  try {
    const { printers } = await api('/print/printers');
    mount(sel, html`<option value="">Chọn máy in</option>${printers.map((p) => html`<option ${p === current ? raw('selected') : ''}>${p}</option>`)}`);
  } catch (err) {
    mount(sel, html`<option value="">${err.message}</option>`);
  }
}

function devicesTab(box) {
  const c = getConfig();
  mount(box, html`
    <div class="grid-even">
      <div class="card">
        <h3>Máy in hóa đơn (cài riêng cho máy này)</h3>
        <form id="printer-form" class="form-grid">
          <label class="field full"><span>Kiểu kết nối</span><select name="mode">
            ${[['browser', 'Qua driver Windows (hộp thoại in)'], ['windows', 'In thẳng ra máy in đã cài (RAW)'], ['network', 'Máy in mạng LAN/WiFi'], ['serial', 'Cổng COM / Bluetooth'], ['usb', 'USB trực tiếp (WebUSB)']]
    .map(([v, l]) => html`<option value="${v}" ${c.mode === v ? raw('selected') : ''}>${l}</option>`)}
          </select></label>
          <p class="hint full" id="mode-help"></p>
          <label class="field"><span>Khổ giấy</span><select name="paper">
            <option value="80" ${c.paper === 80 ? raw('selected') : ''}>80 mm</option>
            <option value="58" ${c.paper === 58 ? raw('selected') : ''}>58 mm</option>
          </select></label>
          <label class="field" data-modes="windows network serial usb"><span>Kiểu in</span><select name="render">
            <option value="image" ${c.render === 'image' ? raw('selected') : ''}>Ảnh (đủ dấu tiếng Việt)</option>
            <option value="text" ${c.render === 'text' ? raw('selected') : ''}>Chữ (nhanh, không dấu)</option>
          </select></label>
          <label class="field" data-modes="network"><span>Địa chỉ IP</span><input name="host" value="${c.host}" placeholder="192.168.1.100"></label>
          <label class="field" data-modes="network"><span>Cổng</span><input name="port" value="${c.port}" inputmode="numeric"></label>
          <label class="field full" data-modes="windows"><span>Máy in</span><select name="printer"><option>Đang tải...</option></select></label>
          <label class="field" data-modes="serial"><span>Tốc độ baud</span><input name="baud" value="${c.baud}" inputmode="numeric"></label>
          <div class="field" data-modes="serial"><span>&nbsp;</span><button type="button" class="btn" id="pair-serial">Chọn cổng COM</button></div>
          <div class="field full" data-modes="usb"><button type="button" class="btn" id="pair-usb">Chọn máy in USB</button></div>
          <label class="field" data-modes="windows network serial usb"><span>Số liên in</span><input name="copies" type="number" min="1" max="5" value="${c.copies}"></label>
          <label class="check full"><input type="checkbox" name="autoPrint" ${c.autoPrint ? raw('checked') : ''}> Tự động in sau khi thanh toán</label>
          <label class="check full" data-modes="windows network serial usb"><input type="checkbox" name="cut" ${c.cut ? raw('checked') : ''}> Tự cắt giấy</label>
          <label class="check full" data-modes="windows network serial usb"><input type="checkbox" name="drawer" ${c.drawer ? raw('checked') : ''}> Mở ngăn kéo tiền khi thanh toán tiền mặt</label>
          <div class="full" style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" id="printer-save">Lưu cấu hình</button>
            <button type="button" class="btn" id="printer-test">In thử</button>
            <button type="button" class="btn" id="drawer-test" data-modes="windows network serial usb">Mở ngăn kéo</button>
          </div>
        </form>
      </div>
      <div>
        <div class="card">
          <h3>Xem trước bản in</h3>
          <div class="preview-bg" id="preview-box"></div>
        </div>
        <div class="card">
          <h3>Máy quét mã vạch</h3>
          <p class="hint"><strong>USB hoặc Bluetooth kiểu bàn phím:</strong> cắm là dùng, không cần cài đặt. Hãy đặt máy quét ở chế độ thêm phím Enter sau mã, và tắt bộ gõ tiếng Việt (Unikey) khi quét.</p>
          <label class="field" style="margin:10px 0"><span>Thử quét vào đây (không cần bấm vào ô)</span><input id="scan-test" readonly placeholder="Chưa nhận được mã nào"></label>
          <p class="hint"><strong>Máy quét cổng COM:</strong> ${serialSupported() ? 'kết nối bên dưới.' : 'trình duyệt này không hỗ trợ, hãy dùng Chrome hoặc Edge.'}</p>
          <div style="display:flex;gap:8px;align-items:end;margin-top:6px">
            <label class="field" style="flex:1"><span>Tốc độ baud</span><input id="scan-baud" value="9600" inputmode="numeric"></label>
            <button class="btn" id="scan-serial" ${serialSupported() ? '' : raw('disabled')}>${serialConnected() ? 'Ngắt kết nối' : 'Kết nối cổng COM'}</button>
          </div>
        </div>
      </div>
    </div>`);
  syncModeFields(box);
  paintPreview(box);
  loadPrinters(box, c.printer);

  const form = $('#printer-form', box);
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('change', (e) => {
    if (e.target.name === 'mode') syncModeFields(box);
    if (e.target.name === 'paper') paintPreview(box);
  });
  box.addEventListener('click', async (e) => {
    const id = e.target.closest('button')?.id;
    if (!id) return;
    try {
      if (id === 'printer-save') {
        saveConfig(readPrinterForm(box));
        toast('Đã lưu cấu hình máy in');
      } else if (id === 'printer-test') {
        await printTest(readPrinterForm(box));
        toast('Đã gửi lệnh in thử');
      } else if (id === 'drawer-test') {
        await openCashDrawer(readPrinterForm(box));
        toast('Đã gửi lệnh mở ngăn kéo');
      } else if (id === 'pair-serial') {
        await pairSerial(Number(form.elements.baud.value));
        toast('Đã kết nối cổng máy in');
      } else if (id === 'pair-usb') {
        await pairUsb();
        toast('Đã kết nối máy in USB');
      } else if (id === 'scan-serial') {
        if (serialConnected()) {
          await disconnectSerialScanner();
          e.target.textContent = 'Kết nối cổng COM';
        } else {
          await connectSerialScanner(Number($('#scan-baud', box).value) || 9600);
          e.target.textContent = 'Ngắt kết nối';
          toast('Đã kết nối máy quét');
        }
      }
    } catch (err) {
      // Người dùng đóng hộp thoại chọn thiết bị không phải là lỗi.
      if (err.name !== 'NotFoundError') showError(err);
    }
  });
  return onScanEvent((code, source) => {
    const input = $('#scan-test', box);
    if (input) input.value = `${code}  (qua ${source === 'serial' ? 'cổng COM' : 'bàn phím'})`;
    beep(true);
  });
}

function storeTab(box) {
  const s = session.settings;
  const admin = isAdmin();
  const lock = admin ? '' : raw('disabled');
  mount(box, html`<form id="store-form" class="card" style="max-width:720px">
    <div class="form-grid">
      <h3 class="full" style="margin:0">Thông tin cửa hàng (in trên hóa đơn)</h3>
      <label class="field full"><span>Tên cửa hàng</span><input name="name" value="${s.store.name}" ${lock}></label>
      <label class="field full"><span>Địa chỉ</span><input name="address" value="${s.store.address}" ${lock}></label>
      <label class="field"><span>Điện thoại</span><input name="phone" value="${s.store.phone}" ${lock}></label>
      <label class="field"><span>Mã số thuế</span><input name="tax_code" value="${s.store.tax_code}" ${lock}></label>
      <h3 class="full" style="margin:8px 0 0">Mẫu hóa đơn</h3>
      <label class="field"><span>Tiêu đề</span><input name="title" value="${s.receipt.title}" ${lock}></label>
      <label class="check" style="align-self:end;padding-bottom:8px"><input type="checkbox" name="show_barcode" ${s.receipt.show_barcode ? raw('checked') : ''} ${lock}> In mã vạch số hóa đơn</label>
      <label class="field full"><span>Lời cuối hóa đơn</span><input name="footer" value="${s.receipt.footer}" ${lock}></label>
      <h3 class="full" style="margin:8px 0 0">Quy tắc bán hàng</h3>
      <label class="field"><span>Thuế GTGT trên hóa đơn (%)</span><input name="tax_rate" value="${s.business.tax_rate}" inputmode="decimal" ${lock}></label>
      <div></div>
      <label class="check full"><input type="checkbox" name="allow_negative_stock" ${s.business.allow_negative_stock ? raw('checked') : ''} ${lock}> Cho phép bán khi hết tồn kho</label>
      <label class="check full"><input type="checkbox" name="cashier_can_edit_price" ${s.business.cashier_can_edit_price ? raw('checked') : ''} ${lock}> Cho phép thu ngân sửa giá bán</label>
      ${admin ? html`<div class="full"><button class="btn btn-primary" id="store-save">Lưu cài đặt</button></div>` : html`<p class="hint full">Chỉ quản trị viên được thay đổi các cài đặt này.</p>`}
    </div>
  </form>`);
  $('#store-form', box).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!admin) return;
    const e = ev.target.elements;
    try {
      session.settings = await api('/settings', {
        method: 'PUT',
        body: {
          store: { name: e.name.value, address: e.address.value, phone: e.phone.value, tax_code: e.tax_code.value },
          receipt: { title: e.title.value, footer: e.footer.value, show_barcode: e.show_barcode.checked },
          business: { tax_rate: Number(e.tax_rate.value.replace(',', '.')) || 0, allow_negative_stock: e.allow_negative_stock.checked, cashier_can_edit_price: e.cashier_can_edit_price.checked },
        },
      });
      toast('Đã lưu cài đặt');
    } catch (err) {
      showError(err);
    }
  });
}

function userForm(u) {
  return html`<div class="form-grid">
    ${u ? '' : html`<label class="field full"><span>Tên đăng nhập</span><input name="username" autocomplete="off" required></label>`}
    <label class="field full"><span>Họ tên</span><input name="full_name" value="${u?.full_name ?? ''}" required></label>
    <label class="field"><span>Vai trò</span><select name="role">
      <option value="cashier" ${u?.role === 'cashier' ? raw('selected') : ''}>Thu ngân</option>
      <option value="admin" ${u?.role === 'admin' ? raw('selected') : ''}>Quản trị viên</option>
    </select></label>
    <label class="field"><span>${u ? 'Mật khẩu mới (bỏ trống nếu giữ nguyên)' : 'Mật khẩu'}</span><input name="password" type="password" autocomplete="new-password"></label>
    ${u ? html`<label class="check full"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}> Đang hoạt động</label>` : ''}
  </div>`;
}

async function usersTab(box) {
  const users = await api('/users');
  mount(box, html`
    <div class="toolbar"><span class="spacer"></span><button class="btn btn-primary" id="user-add">+ Thêm nhân viên</button></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Tên đăng nhập</th><th>Họ tên</th><th>Vai trò</th><th>Trạng thái</th><th>Ngày tạo</th></tr></thead>
      <tbody>${users.map((u) => html`<tr class="clickable" data-user="${u.id}"><td class="strong">${u.username}</td><td>${u.full_name}</td>
        <td>${u.role === 'admin' ? 'Quản trị viên' : 'Thu ngân'}</td>
        <td>${u.active ? html`<span class="badge badge-good">Hoạt động</span>` : html`<span class="badge">Đã khóa</span>`}</td><td>${fmtDate(u.created_at)}</td></tr>`)}</tbody>
    </table></div>`);
  $('#user-add', box).addEventListener('click', () => openModal({
    title: 'Thêm nhân viên',
    body: userForm(),
    onSubmit: async (data) => {
      await api('/users', { method: 'POST', body: data });
      toast('Đã thêm nhân viên');
      usersTab(box).catch(showError);
    },
  }));
  box.querySelector('tbody').addEventListener('click', (e) => {
    const row = e.target.closest('[data-user]');
    if (!row) return;
    const u = users.find((x) => x.id === Number(row.dataset.user));
    openModal({
      title: `Sửa ${u.username}`,
      body: userForm(u),
      onSubmit: async (data) => {
        await api(`/users/${u.id}`, { method: 'PUT', body: data });
        toast('Đã lưu');
        usersTab(box).catch(showError);
      },
    });
  });
}

function backupTab(box) {
  mount(box, html`<div class="card" style="max-width:620px">
    <h3>Sao lưu dữ liệu</h3>
    <p class="muted">Tải về một bản sao toàn bộ dữ liệu. Nên sao lưu hằng ngày và cất ở nơi khác máy này.</p>
    <a class="btn btn-primary" href="/api/backup" download>Tải bản sao lưu</a>
    <p class="hint" style="margin-top:12px">Phục hồi: tắt phần mềm, chép file sao lưu đè lên <code>data/bannhanh.db</code> (xóa các file -wal, -shm nếu có), rồi mở lại.</p>
  </div>`);
}

function shortcutTab(box) {
  mount(box, html`<div class="card" style="max-width:620px">
    <h3>Shortcut khởi động nhanh</h3>
    <p class="muted">Tạo biểu tượng BanNhanh trên Desktop và trong Start Menu của máy đang chạy phần mềm. Bấm vào biểu tượng để bật phần mềm và mở trình duyệt; nếu phần mềm đang chạy thì chỉ mở trình duyệt.</p>
    <button class="btn btn-primary" id="shortcut-create">Tạo shortcut</button>
    <div id="shortcut-result" style="margin-top:12px"></div>
    <p class="hint" style="margin-top:12px">Phần mềm chạy trong một cửa sổ thu nhỏ ở thanh tác vụ, đóng cửa sổ đó là tắt phần mềm. Nếu chuyển thư mục phần mềm, hãy bấm tạo lại, hoặc chạy <code>tao-shortcut.bat</code> trong thư mục mới.</p>
  </div>`);
  const btn = $('#shortcut-create', box);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { paths } = await api('/system/shortcut', { method: 'POST' });
      mount($('#shortcut-result', box), html`<p class="good strong">Đã tạo shortcut:</p>${paths.map((p) => html`<div class="small muted">${p}</div>`)}`);
    } catch (err) {
      showError(err);
    } finally {
      btn.disabled = false;
    }
  });
}

export async function render(root) {
  const tabs = [['devices', 'Máy in và máy quét'], ['store', 'Cửa hàng'], ...(isAdmin() ? [['users', 'Nhân viên'], ['backup', 'Sao lưu'], ['shortcut', 'Shortcut']] : [])];
  if (!tabs.some(([id]) => id === state.tab)) state.tab = 'devices';
  mount(root, html`
    <div class="page-head"><h1>Cài đặt</h1></div>
    <div class="tabs" role="tablist">${tabs.map(([id, label]) => html`<button data-tab="${id}" class="${id === state.tab ? 'active' : ''}">${label}</button>`)}</div>
    <div id="st-body"></div>`);
  let off = null;
  const show = async () => {
    off?.();
    off = null;
    // Thay nút mới để bỏ các listener của tab cũ.
    const old = $('#st-body', root);
    const body = old.cloneNode(false);
    old.replaceWith(body);
    if (state.tab === 'devices') off = devicesTab(body);
    else if (state.tab === 'store') storeTab(body);
    else if (state.tab === 'users') await usersTab(body);
    else if (state.tab === 'shortcut') shortcutTab(body);
    else backupTab(body);
  };
  await show();
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.tabs [data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    $$('.tabs button', root).forEach((x) => x.classList.toggle('active', x === b));
    show().catch(showError);
  });
  return () => off?.();
}
