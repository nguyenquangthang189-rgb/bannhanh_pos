// Đọc chữ trong ảnh bằng Tesseract (chạy tại máy, không cần Internet, không dùng AI).
import path from 'node:path';
import { createRequire } from 'node:module';
import { HttpError } from '../util.js';

const require = createRequire(import.meta.url);
const IDLE_MS = 5 * 60 * 1000; // worker chiếm ~150 MB RAM, nên tắt khi lâu không dùng

let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve();

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      let tesseract;
      let vie;
      try {
        tesseract = require('tesseract.js');
        vie = require('@tesseract.js-data/vie');
      } catch {
        throw new HttpError(500, 'Thiếu thư viện đọc ảnh. Hãy chạy "npm install" trong thư mục phần mềm rồi mở lại');
      }
      // Dữ liệu tiếng Việt nằm sẵn trong node_modules: không tải gì từ Internet, không ghi file cache.
      const worker = await tesseract.createWorker('vie', tesseract.OEM.LSTM_ONLY, {
        langPath: path.join(path.dirname(vie.langPath), '4.0.0_best_int'),
        gzip: true,
        cacheMethod: 'none',
      });
      // Coi cả ảnh là một khối chữ để Tesseract không tách các cột của bảng thành đoạn riêng.
      await worker.setParameters({ tessedit_pageseg_mode: tesseract.PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

function scheduleIdleStop() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const pending = workerPromise;
    workerPromise = null;
    (await pending?.catch(() => null))?.terminate();
  }, IDLE_MS);
  idleTimer.unref();
}

/** Trả về các từ kèm toạ độ. Mỗi lần chỉ đọc một ảnh vì worker xử lý tuần tự. */
export function recognize(image) {
  const job = queue.then(async () => {
    const worker = await getWorker();
    try {
      const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
      const words = [];
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            for (const w of line.words) {
              const text = w.text.trim();
              const symbols = (w.symbols ?? []).map((sym) => ({ text: sym.text, x0: sym.bbox.x0, x1: sym.bbox.x1 }));
              if (text) words.push({ text, conf: w.confidence, ...w.bbox, symbols });
            }
          }
        }
      }
      return { text: data.text ?? '', confidence: data.confidence ?? 0, words };
    } finally {
      scheduleIdleStop();
    }
  });
  queue = job.catch(() => {});
  return job;
}

export async function stopOcr() {
  clearTimeout(idleTimer);
  const pending = workerPromise;
  workerPromise = null;
  await (await pending?.catch(() => null))?.terminate();
}
