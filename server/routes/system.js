import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../util.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'create-shortcut.ps1');

const isLoopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

function createShortcuts() {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];
  if (process.env.BN_SHORTCUT_DIR) args.push('-OutDir', process.env.BN_SHORTCUT_DIR);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(JSON.parse(stdout.replace(/^﻿/, '')));
    });
  });
}

export function register(r) {
  r.post('/api/system/shortcut', 'admin', async ({ req }) => {
    if (process.platform !== 'win32') throw new HttpError(400, 'Chức năng này chỉ dùng trên Windows');
    // Shortcut nằm trên máy chạy phần mềm, nên quầy khác trong LAN bấm nút cũng không có tác dụng với máy của họ.
    if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(403, 'Hãy tạo shortcut trên chính máy đang chạy phần mềm');
    try {
      return { paths: await createShortcuts() };
    } catch (err) {
      throw new HttpError(502, `Không tạo được shortcut: ${err.message}`);
    }
  });
}
