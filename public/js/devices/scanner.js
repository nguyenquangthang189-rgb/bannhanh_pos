// Máy quét mã vạch: nhận từ 3 nguồn và đưa về một trình xử lý duy nhất của trang đang mở.
//  1. USB/Bluetooth kiểu bàn phím (phổ biến nhất): nhận diện chuỗi phím gõ rất nhanh, không cần cài đặt gì.
//  2. Cổng COM/USB-Serial qua Web Serial.
//  3. Camera điện thoại/laptop.

const MAX_GAP_MS = 50; // máy quét gõ dưới 50 ms mỗi ký tự; người gõ tay không giữ được nhịp này suốt cả mã
const MIN_LENGTH = 4;
const NO_SUFFIX_MIN_LENGTH = 6;
const NO_SUFFIX_IDLE_MS = 100;

let handler = null;
export function setScanHandler(fn) {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

const listeners = new Set();
/** Theo dõi mọi lần quét (dùng cho ô kiểm tra máy quét trong Cài đặt). */
export function onScanEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function dispatch(code, source) {
  const clean = code.trim();
  if (!clean) return;
  listeners.forEach((fn) => fn(clean, source));
  handler?.(clean, source);
}

let buffer = '';
let lastKeyAt = 0;
let snapshot = null;
let idleTimer = null;

const isTextInput = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(el.type)));

/** Máy quét đã gõ ký tự vào ô đang focus; khôi phục giá trị cũ để mã không dính vào ô đó. */
function restoreInput() {
  if (!snapshot) return;
  const { el, value } = snapshot;
  if (el.isConnected && el.value !== value) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function finishBurst() {
  const code = buffer;
  buffer = '';
  restoreInput();
  snapshot = null;
  dispatch(code, 'keyboard');
}

function onKeydown(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const t = performance.now();
  const gap = t - lastKeyAt;
  clearTimeout(idleTimer);

  if (e.key === 'Enter' || e.key === 'Tab') {
    if (buffer.length >= MIN_LENGTH && gap <= MAX_GAP_MS * 2) {
      e.preventDefault();
      e.stopImmediatePropagation();
      finishBurst();
    }
    buffer = '';
    snapshot = null;
    return;
  }
  if (e.key.length !== 1) return;

  if (gap > MAX_GAP_MS) {
    buffer = '';
    const el = document.activeElement;
    snapshot = isTextInput(el) ? { el, value: el.value } : null;
  }
  buffer += e.key;
  lastKeyAt = t;
  // Một số máy quét được cấu hình không gửi Enter: chốt mã khi dừng gõ.
  if (buffer.length >= NO_SUFFIX_MIN_LENGTH) idleTimer = setTimeout(finishBurst, NO_SUFFIX_IDLE_MS);
}
document.addEventListener('keydown', onKeydown, true);

// ----- Cổng serial -----
let serialPort = null;
let serialReader = null;

export const serialSupported = () => 'serial' in navigator;
export const serialConnected = () => Boolean(serialPort);

async function readSerialLoop(port) {
  const decoder = new TextDecoder();
  let pending = '';
  while (port.readable && serialPort === port) {
    serialReader = port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await serialReader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/[\r\n]+/);
        pending = lines.pop();
        lines.forEach((line) => dispatch(line, 'serial'));
      }
    } catch {
      break; // rút cáp: thoát vòng lặp
    } finally {
      serialReader.releaseLock();
    }
  }
}

async function openSerial(port, baudRate) {
  await port.open({ baudRate });
  serialPort = port;
  readSerialLoop(port);
}

export async function connectSerialScanner(baudRate = 9600) {
  if (!serialSupported()) throw new Error('Trình duyệt này không hỗ trợ Web Serial. Hãy dùng Chrome hoặc Edge.');
  await disconnectSerialScanner();
  const port = await navigator.serial.requestPort();
  await openSerial(port, baudRate);
  localStorage.setItem('scanner.serialBaud', String(baudRate));
}

export async function disconnectSerialScanner() {
  const port = serialPort;
  serialPort = null;
  localStorage.removeItem('scanner.serialBaud');
  if (!port) return;
  try {
    await serialReader?.cancel();
    await port.close();
  } catch { /* cổng đã đóng */ }
}

/** Tự nối lại cổng đã được cấp quyền từ lần trước. */
export async function restoreSerialScanner() {
  const baud = Number(localStorage.getItem('scanner.serialBaud'));
  if (!baud || !serialSupported()) return;
  const [port] = await navigator.serial.getPorts();
  if (port) await openSerial(port, baud).catch(() => {});
}

// ----- Camera -----
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];

/**
 * Quét bằng camera. Dùng BarcodeDetector có sẵn của trình duyệt (Chrome Android, macOS);
 * trên Windows trình duyệt không có API này nên tải thư viện ZXing từ CDN (cần Internet).
 */
export async function startCameraScan(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera chỉ hoạt động trên localhost hoặc HTTPS.');
  }
  let stopped = false;
  if ('BarcodeDetector' in window) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    await video.play();
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const detector = new window.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
    const tick = async () => {
      if (stopped) return;
      try {
        const [hit] = await detector.detect(video);
        if (hit) onCode(hit.rawValue);
      } catch { /* khung hình chưa sẵn sàng */ }
      setTimeout(tick, 250);
    };
    tick();
    return () => {
      stopped = true;
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    };
  }
  if (!window.ZXing) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Không tải được thư viện quét camera. Kiểm tra kết nối Internet.'));
      document.head.append(s);
    });
  }
  const reader = new window.ZXing.BrowserMultiFormatReader();
  await reader.decodeFromVideoDevice(undefined, video, (result) => {
    if (result && !stopped) onCode(result.getText());
  });
  return () => {
    stopped = true;
    reader.reset();
  };
}

// ----- Âm báo -----
let audio;
export function beep(ok = true) {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = ok ? 1500 : 300;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (ok ? 0.07 : 0.3));
  } catch { /* máy không có âm thanh */ }
}
