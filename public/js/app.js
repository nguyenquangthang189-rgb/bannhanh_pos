import { api, html, mount, $, session, isAdmin, showError, openModal, toast } from './core.js';
import { restoreSerialScanner, setScanHandler } from './devices/scanner.js';

const NAV = [
  { href: '#/', label: 'Tổng quan', admin: true },
  { href: '#/products', label: 'Hàng hóa' },
  { href: '#/purchases', label: 'Nhập hàng', admin: true },
  { href: '#/stocktakes', label: 'Kiểm kho', admin: true },
  { href: '#/invoices', label: 'Hóa đơn' },
  { href: '#/customers', label: 'Khách hàng' },
  { href: '#/suppliers', label: 'Nhà cung cấp', admin: true },
  { href: '#/cashbook', label: 'Sổ quỹ', admin: true },
  { href: '#/reports', label: 'Báo cáo' },
  { href: '#/settings', label: 'Cài đặt' },
];

const ROUTES = {
  '': () => import('./pages/dashboard.js'),
  pos: () => import('./pages/pos.js'),
  products: () => import('./pages/products.js'),
  purchases: () => import('./pages/purchases.js'),
  stocktakes: () => import('./pages/stocktakes.js'),
  invoices: () => import('./pages/invoices.js'),
  customers: () => import('./pages/partners.js'),
  suppliers: () => import('./pages/partners.js'),
  cashbook: () => import('./pages/cashbook.js'),
  reports: () => import('./pages/reports.js'),
  settings: () => import('./pages/settings.js'),
};

const app = $('#app');
let cleanup = null;
let renderSeq = 0;

function shell() {
  const route = location.hash.replace(/^#\/?/, '').split('/')[0];
  mount(app, html`
    <nav class="topnav" aria-label="Điều hướng chính">
      <a class="brand" href="${isAdmin() ? '#/' : '#/pos'}"><i></i>BanNhanh</a>
      ${NAV.filter((n) => !n.admin || isAdmin()).map((n) => html`
        <a class="nav ${n.href.replace('#/', '') === route ? 'active' : ''}" href="${n.href}">${n.label}</a>`)}
      <span class="spacer"></span>
      <a class="btn btn-sm btn-pos" href="#/pos">Bán hàng</a>
      <button class="user-chip" id="user-menu">${session.user.full_name} ▾</button>
    </nav>
    <main class="page" id="page"></main>`);
  $('#user-menu').addEventListener('click', openUserMenu);
  return $('#page');
}

function openUserMenu() {
  openModal({
    title: session.user.full_name,
    body: html`<div class="form-grid">
      <label class="field full"><span>Mật khẩu hiện tại</span><input type="password" name="current" autocomplete="current-password"></label>
      <label class="field full"><span>Mật khẩu mới (ít nhất 6 ký tự)</span><input type="password" name="password" autocomplete="new-password"></label>
    </div>`,
    submitLabel: 'Đổi mật khẩu',
    footer: html`<button type="button" class="btn btn-danger" id="logout-btn">Đăng xuất</button>`,
    onMount: (root) => $('#logout-btn', root).addEventListener('click', logout),
    onSubmit: async (data) => {
      await api('/auth/password', { method: 'POST', body: data });
      toast('Đã đổi mật khẩu');
    },
  });
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  location.hash = '';
  location.reload();
}

async function route() {
  const seq = ++renderSeq;
  cleanup?.();
  cleanup = null;
  setScanHandler(null);
  document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());

  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  let name = parts[0];
  // Thu ngân không có quyền xem Tổng quan nên vào thẳng màn hình bán hàng.
  if (name === '' && !isAdmin()) {
    location.hash = '#/pos';
    return;
  }
  if (!ROUTES[name]) name = '';
  try {
    const mod = await ROUTES[name]();
    if (seq !== renderSeq) return;
    const root = name === 'pos' ? app : shell();
    if (name === 'pos') app.innerHTML = '';
    cleanup = (await mod.render(root, { name, parts })) ?? null;
  } catch (err) {
    showError(err);
    if (seq === renderSeq && $('#page')) mount($('#page'), html`<div class="empty">${err.message}</div>`);
  }
}

function authScreen(needsSetup) {
  mount(app, html`
    <div class="auth-screen">
      <form class="auth-card" novalidate>
        <div class="brand"><i></i>BanNhanh</div>
        ${needsSetup ? html`
          <p class="muted">Chào mừng! Hãy tạo tài khoản chủ cửa hàng để bắt đầu.</p>
          <label class="field"><span>Tên cửa hàng</span><input name="store_name" required autofocus></label>
          <label class="field"><span>Họ tên của bạn</span><input name="full_name" required></label>` : ''}
        <label class="field"><span>Tên đăng nhập</span><input name="username" autocomplete="username" required ${needsSetup ? '' : html`autofocus`}></label>
        <label class="field"><span>Mật khẩu${needsSetup ? ' (ít nhất 6 ký tự)' : ''}</span><input name="password" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required></label>
        ${needsSetup ? html`<label class="check"><input type="checkbox" name="demo" checked> Tạo dữ liệu mẫu để dùng thử</label>` : ''}
        <div class="form-error" id="auth-error" role="alert"></div>
        <button class="btn btn-primary" type="submit">${needsSetup ? 'Bắt đầu sử dụng' : 'Đăng nhập'}</button>
      </form>
    </div>`);
  const form = $('form', app);
  $('[autofocus]', form)?.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.demo = Boolean(data.demo);
    const btn = $('button', form);
    btn.disabled = true;
    try {
      await api(needsSetup ? '/auth/setup' : '/auth/login', { method: 'POST', body: data });
      location.reload();
    } catch (err) {
      $('#auth-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

async function start() {
  const state = await api('/auth/state');
  if (!state.user) {
    authScreen(state.needsSetup);
    return;
  }
  session.user = state.user;
  session.settings = await api('/settings');
  restoreSerialScanner();
  window.addEventListener('hashchange', route);
  route();
}

start().catch((err) => mount(app, html`<div class="empty">${err.message}</div>`));
