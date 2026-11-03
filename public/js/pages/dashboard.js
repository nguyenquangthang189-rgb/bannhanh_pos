import { api, html, mount, raw, $, money, qtyFmt, fmtDate } from '../core.js';

function delta(cur, prev) {
  if (!prev) return cur ? 'Hôm qua chưa có số liệu' : 'Bằng hôm qua';
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  return pct === 0 ? 'Bằng hôm qua' : `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% so với hôm qua`;
}

const shortMoney = (v) => {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace('.0', '')} tỷ`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace('.0', '')} tr`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} k`;
  return String(v);
};

function niceMax(v) {
  if (v <= 0) return 100000;
  const mag = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= v);
  return step * mag;
}

/** Biểu đồ cột một chuỗi, không dùng thư viện. Trục y là trục duy nhất, tiêu đề đã nêu tên chuỗi. */
function revenueChart(rows) {
  const W = 760;
  const H = 240;
  const pad = { l: 46, r: 8, t: 10, b: 24 };
  const max = niceMax(Math.max(...rows.map((r) => r.revenue), 0));
  const plotH = H - pad.t - pad.b;
  const slot = (W - pad.l - pad.r) / rows.length;
  const barW = Math.max(slot - 2, 2); // khe 2px giữa các cột
  const y = (v) => pad.t + plotH - (Math.max(v, 0) / max) * plotH;
  const ticks = [0, 0.5, 1].map((f) => f * max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Doanh thu thuần 30 ngày gần nhất">`;
  for (const t of ticks) {
    svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += `<text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${shortMoney(t)}</text>`;
  }
  rows.forEach((r, i) => {
    const x = pad.l + i * slot + 1;
    const top = y(r.revenue);
    const h = pad.t + plotH - top;
    if (h > 0) {
      const radius = Math.min(4, barW / 2, h);
      // Chỉ bo đầu cột, chân cột giữ phẳng để bám đường đáy.
      svg += `<path class="bar" data-i="${i}" d="M${x},${top + h} V${top + radius} Q${x},${top} ${x + radius},${top} H${x + barW - radius} Q${x + barW},${top} ${x + barW},${top + radius} V${top + h} Z"/>`;
    }
    svg += `<rect class="hit" data-i="${i}" x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${plotH}" fill="transparent"/>`;
    if (i % 5 === 4 || i === rows.length - 1 && rows.length % 5 === 0) {
      svg += `<text x="${x + barW / 2}" y="${H - 7}" text-anchor="middle">${r.day.slice(8, 10)}/${r.day.slice(5, 7)}</text>`;
    }
  });
  return `${svg}</svg>`;
}

function attachChartHover(box, rows) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  box.append(tip);
  box.addEventListener('mousemove', (e) => {
    const i = e.target.dataset?.i;
    box.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
    if (i === undefined) {
      tip.hidden = true;
      return;
    }
    const r = rows[Number(i)];
    box.querySelector(`.bar[data-i="${i}"]`)?.classList.add('hover');
    mount(tip, html`<b>${fmtDate(r.day)}</b>Doanh thu: ${money(r.revenue)} đ<br>Lợi nhuận gộp: ${money(r.profit)} đ<br>${r.invoice_count} hóa đơn`);
    const rect = box.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(e.clientX - rect.left, 80), rect.width - 80)}px`;
    tip.style.top = `${Math.max(e.clientY - rect.top - 10, 66)}px`;
  });
  box.addEventListener('mouseleave', () => {
    tip.hidden = true;
    box.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
  });
}

export async function render(root) {
  const d = await api('/reports/dashboard');
  const t = d.today;
  const y = d.yesterday;
  mount(root, html`
    <div class="page-head"><h1>Tổng quan hôm nay</h1></div>
    <div class="stats">
      <div class="stat"><div class="label">Doanh thu thuần</div><div class="value">${money(t.revenue)}</div><div class="delta">${delta(t.revenue, y.revenue)}</div></div>
      <div class="stat"><div class="label">Lợi nhuận gộp</div><div class="value">${money(t.gross_profit)}</div><div class="delta">${delta(t.gross_profit, y.gross_profit)}</div></div>
      <div class="stat"><div class="label">Số hóa đơn</div><div class="value">${money(t.invoice_count)}</div><div class="delta">${t.return_count} phiếu trả hàng</div></div>
      <div class="stat"><div class="label">Khách đang nợ</div><div class="value">${money(d.receivable)}</div><div class="delta"><a href="#/customers">Xem công nợ</a></div></div>
      <div class="stat"><div class="label">Nợ nhà cung cấp</div><div class="value">${money(d.payable)}</div><div class="delta"><a href="#/suppliers">Xem công nợ</a></div></div>
      <div class="stat"><div class="label">Giá trị tồn kho</div><div class="value">${money(d.inventory_value)}</div><div class="delta">Tính theo giá vốn</div></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h3>Doanh thu thuần 30 ngày gần nhất (đ)</h3>
        <div class="chart" id="rev-chart">${raw(revenueChart(d.chart))}</div>
      </div>
      <div>
        <div class="card">
          <h3>Bán chạy 30 ngày</h3>
          ${d.top_products.length ? d.top_products.map((p) => html`<div class="kv"><span>${p.name}<br><span class="small muted">Đã bán ${qtyFmt(p.sold - p.returned)} ${p.unit}</span></span><span class="num">${money(p.revenue)}</span></div>`) : html`<p class="muted">Chưa có giao dịch.</p>`}
        </div>
        <div class="card">
          <h3>Sắp hết hàng</h3>
          ${d.low_stock.length ? d.low_stock.map((p) => html`<div class="kv"><span>${p.name}</span><span class="num ${p.stock <= 0 ? 'bad' : ''}">${qtyFmt(p.stock)} ${p.unit}</span></div>`) : html`<p class="muted">Tồn kho đang ổn.</p>`}
        </div>
      </div>
    </div>`);
  attachChartHover($('#rev-chart', root), d.chart);
}
