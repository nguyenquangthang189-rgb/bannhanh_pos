// Điều phối in hóa đơn. Cấu hình lưu theo từng máy (localStorage), vì mỗi quầy nối một máy in riêng.
import { api, session } from '../core.js';
import * as esc from './escpos.js';
import { buildReceipt, buildTestReceipt, receiptHtml, receiptCanvas, canvasToBits, receiptText } from './receipt.js';

const KEY = 'printer.config';
const DEFAULTS = {
  mode: 'browser', // browser | network | windows | serial | usb
  paper: 80,
  render: 'image', // image: giữ dấu tiếng Việt | text: nhanh, không dấu
  host: '',
  port: 9100,
  printer: '',
  baud: 9600,
  autoPrint: true,
  cut: true,
  drawer: false,
  copies: 1,
};

export function getConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveConfig(cfg) {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

/** In qua driver của trình duyệt bằng iframe ẩn, để không phải mở cửa sổ mới. */
export function printHtml(doc) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-1000px';
    frame.onload = () => {
      const win = frame.contentWindow;
      win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 200));
      win.focus();
      win.print();
      resolve();
    };
    frame.srcdoc = doc;
    document.body.append(frame);
  });
}

export function encodeJob(lines, cfg) {
  const parts = [esc.init()];
  if (cfg.render === 'text') {
    parts.push(esc.asciiBytes(receiptText(lines, cfg.paper)));
  } else {
    const { bits, width, height } = canvasToBits(receiptCanvas(lines, cfg.paper));
    parts.push(esc.raster(bits, width, height));
  }
  parts.push(esc.feed(4));
  if (cfg.cut) parts.push(esc.cut());
  return esc.concatBytes(parts);
}

// ----- Kết nối trực tiếp từ trình duyệt -----
let serialPort = null;
export const serialSupported = () => 'serial' in navigator;
export const usbSupported = () => 'usb' in navigator;

export async function pairSerial(baud) {
  if (!serialSupported()) throw new Error('Trình duyệt này không hỗ trợ Web Serial. Hãy dùng Chrome hoặc Edge.');
  serialPort = await navigator.serial.requestPort();
  await ensureSerial(baud);
}

async function ensureSerial(baud) {
  if (!serialPort) [serialPort] = await navigator.serial.getPorts();
  if (!serialPort) throw new Error('Chưa chọn cổng máy in. Vào Cài đặt để kết nối.');
  if (!serialPort.writable) await serialPort.open({ baudRate: Number(baud) || 9600 });
}

async function writeSerial(bytes, baud) {
  await ensureSerial(baud);
  const writer = serialPort.writable.getWriter();
  try {
    await writer.write(bytes);
    await writer.ready;
  } finally {
    writer.releaseLock();
  }
}

let usbDevice = null;
export async function pairUsb() {
  if (!usbSupported()) throw new Error('Trình duyệt này không hỗ trợ WebUSB. Hãy dùng Chrome hoặc Edge.');
  usbDevice = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] });
  await openUsb();
}

async function openUsb() {
  if (!usbDevice) [usbDevice] = await navigator.usb.getDevices();
  if (!usbDevice) throw new Error('Chưa chọn máy in USB. Vào Cài đặt để kết nối.');
  if (!usbDevice.opened) await usbDevice.open();
  if (!usbDevice.configuration) await usbDevice.selectConfiguration(1);
  for (const iface of usbDevice.configuration.interfaces) {
    for (const alt of iface.alternates) {
      const out = alt.endpoints.find((ep) => ep.direction === 'out');
      if (alt.interfaceClass === 7 && out) {
        if (!iface.claimed) await usbDevice.claimInterface(iface.interfaceNumber);
        return out.endpointNumber;
      }
    }
  }
  throw new Error('Thiết bị đã chọn không phải máy in USB.');
}

async function writeUsb(bytes) {
  const endpoint = await openUsb();
  const CHUNK = 16 * 1024;
  for (let i = 0; i < bytes.length; i += CHUNK) await usbDevice.transferOut(endpoint, bytes.subarray(i, i + CHUNK));
}

async function sendBytes(bytes, cfg) {
  switch (cfg.mode) {
    case 'network':
      await api('/print/raw', { method: 'POST', body: { transport: 'network', host: cfg.host, port: Number(cfg.port) || 9100, data: esc.toBase64(bytes) } });
      break;
    case 'windows':
      await api('/print/raw', { method: 'POST', body: { transport: 'windows', printer: cfg.printer, data: esc.toBase64(bytes) } });
      break;
    case 'serial':
      await writeSerial(bytes, cfg.baud);
      break;
    case 'usb':
      await writeUsb(bytes);
      break;
    default:
      throw new Error('Kiểu kết nối máy in không hợp lệ');
  }
}

async function printLines(lines, cfg, { kickDrawer }) {
  if (cfg.mode === 'browser') {
    await printHtml(receiptHtml(lines, cfg.paper));
    return;
  }
  const job = encodeJob(lines, cfg);
  const copies = Math.max(Number(cfg.copies) || 1, 1);
  const parts = kickDrawer ? [esc.openDrawer()] : [];
  for (let i = 0; i < copies; i += 1) parts.push(job);
  await sendBytes(esc.concatBytes(parts), cfg);
}

export async function printInvoice(invoice, { kickDrawer = false } = {}) {
  const cfg = getConfig();
  await printLines(buildReceipt(invoice, session.settings), cfg, { kickDrawer: kickDrawer && cfg.drawer });
}

export async function printTest(cfg = getConfig()) {
  await printLines(buildTestReceipt(session.settings), cfg, { kickDrawer: false });
}

export async function openCashDrawer(cfg = getConfig()) {
  if (cfg.mode === 'browser') throw new Error('Mở ngăn kéo cần chế độ in trực tiếp (LAN, Windows RAW, COM hoặc USB).');
  await sendBytes(esc.openDrawer(), cfg);
}
