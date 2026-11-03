// Tiện ích dùng chung: template an toàn XSS, gọi API, định dạng, modal, thông báo.

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderValue(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return esc(v);
}

/** Tagged template: mọi giá trị đều được escape, trừ giá trị đã là html`...`. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += renderValue(v) + strings[i + 1]; });
  return new Raw(out);
}
export const raw = (s) => new Raw(s);

export function mount(el, content) {
  el.innerHTML = renderValue(content);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const session = { user: null, settings: null };
export const isAdmin = () => session.user?.role === 'admin';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, query } = {}) {
  let url = `/api${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, v);
    const s = params.toString();
    if (s) url += `?${s}`;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Không kết nối được máy chủ. Kiểm tra lại phần mềm hoặc mạng.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) location.reload();
    throw new ApiError(res.status, data.error || 'Có lỗi xảy ra');
  }
  return data;
}

const moneyFmt = new Intl.NumberFormat('vi-VN');
export const money = (n) => moneyFmt.format(Math.round(Number(n) || 0));
export const qtyFmt = (n) => moneyFmt.format(Math.round((Number(n) || 0) * 1000) / 1000);
export const parseMoney = (s) => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;
export const parseQty = (s) => Number(String(s ?? '').trim().replace(',', '.'));
export const fmtDateTime = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 16)}` : '');
export const fmtDate = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');

const pad = (n) => String(n).padStart(2, '0');
export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

export const METHOD_LABEL = { cash: 'Tiền mặt', bank: 'Chuyển khoản', card: 'Thẻ' };

// Ô nhập tiền tự thêm dấu phân cách hàng nghìn.
document.addEventListener('input', (e) => {
  if (e.target.matches?.('input.money')) {
    const n = parseMoney(e.target.value);
    e.target.value = e.target.value.trim() === '' ? '' : money(n);
  }
});

export function toast(message, type = 'ok') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

export const showError = (err) => toast(err.message || String(err), 'error');

const modalStack = [];
export const modalOpen = () => modalStack.length > 0;

/** Mở hộp thoại. `onSubmit` nhận FormData dạng object; trả về false để giữ hộp thoại mở. */
export function openModal({ title, body, wide = false, submitLabel = 'Lưu', cancelLabel = 'Đóng', onSubmit, onMount, footer }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const close = () => {
    overlay.remove();
    modalStack.splice(modalStack.indexOf(close), 1);
  };
  mount(overlay, html`
    <form class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}" novalidate>
      <header class="modal-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Đóng">×</button></header>
      <div class="modal-body">${body}</div>
      <footer class="modal-foot">
        ${footer ?? ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-close>${cancelLabel}</button>
        ${onSubmit ? html`<button type="submit" class="btn btn-primary">${submitLabel}</button>` : ''}
      </footer>
    </form>`);
  const form = $('form', overlay);
  overlay.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const data = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.type === 'checkbox') data[el.name] = el.checked;
        else if (el.classList.contains('money')) data[el.name] = parseMoney(el.value);
        else data[el.name] = el.value;
      }
      if ((await onSubmit(data, form)) !== false) close();
    } catch (err) {
      showError(err);
    } finally {
      btn.disabled = false;
    }
  });
  document.body.append(overlay);
  modalStack.push(close);
  onMount?.(overlay, close);
  const focusable = $('[autofocus], input:not([type=hidden]), select, textarea', form);
  focusable?.focus();
  return { close, root: overlay };
}

export function confirmBox(title, message, label = 'Đồng ý') {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      body: html`<p>${message}</p>`,
      submitLabel: label,
      onSubmit: () => { answered = true; resolve(true); },
      onMount: (overlay) => {
        const obs = new MutationObserver(() => {
          if (!overlay.isConnected) {
            obs.disconnect();
            if (!answered) resolve(false);
          }
        });
        obs.observe(document.body, { childList: true });
      },
    });
  });
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function downloadCsv(filename, headers, rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    // Ô bắt đầu bằng ký tự công thức bị Excel thực thi, nên chèn dấu nháy để vô hiệu hóa.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Đọc CSV (có ngoặc kép, dấu , hoặc ;) thành mảng object theo dòng tiêu đề. */
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { cur += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function pager(total, page, limit) {
  const pages = Math.max(Math.ceil(total / limit), 1);
  return html`<div class="pager">
    <span>${money(total)} dòng</span><span class="spacer"></span>
    <button class="btn btn-sm" data-page="${page - 1}" ${page <= 1 ? raw('disabled') : ''}>‹ Trước</button>
    <span>Trang ${page}/${pages}</span>
    <button class="btn btn-sm" data-page="${page + 1}" ${page >= pages ? raw('disabled') : ''}>Sau ›</button>
  </div>`;
}

/** Hộp tìm kiếm thả xuống dùng chung cho hàng hóa, khách hàng, nhà cung cấp. */
export function attachSearch(input, { search, renderItem, onPick }) {
  const box = document.createElement('div');
  box.className = 'search-drop';
  box.hidden = true;
  input.parentElement.classList.add('search-wrap');
  input.parentElement.append(box);
  let items = [];
  let active = 0;
  let seq = 0;

  const paint = () => {
    if (!items.length) {
      box.innerHTML = '<div class="search-empty">Không tìm thấy</div>';
      return;
    }
    mount(box, items.map((it, i) => html`<button type="button" class="search-item ${i === active ? 'active' : ''}" data-i="${i}">${renderItem(it)}</button>`));
  };
  const hide = () => { box.hidden = true; };
  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) return hide();
    const mine = ++seq;
    try {
      const res = await search(q);
      if (mine !== seq) return;
      items = res;
      active = 0;
      box.hidden = false;
      paint();
    } catch (err) {
      showError(err);
    }
  }, 150);
  const pick = (it) => {
    hide();
    seq += 1;
    onPick(it);
  };
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) pick(items[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); hide(); }
  });
  box.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('[data-i]');
    if (btn) {
      e.preventDefault();
      pick(items[Number(btn.dataset.i)]);
    }
  });
  input.addEventListener('blur', () => setTimeout(hide, 120));
}
