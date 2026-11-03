import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';

const MAX_BODY = 8 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' about:",
};

export class Router {
  routes = [];

  /** access: 'public' | 'user' (mặc định) | 'admin' */
  add(method, pattern, access, handler) {
    if (!handler) [access, handler] = ['user', access];
    const names = [];
    const source = pattern.replace(/:(\w+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${source}$`), names, access, handler });
  }
  get(p, a, h) { this.add('GET', p, a, h); }
  post(p, a, h) { this.add('POST', p, a, h); }
  put(p, a, h) { this.add('PUT', p, a, h); }
  delete(p, a, h) { this.add('DELETE', p, a, h); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.re.exec(pathname);
      if (m) {
        const params = {};
        route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        return { route, params };
      }
    }
    return null;
  }
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Dữ liệu gửi lên quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object') throw new Error();
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Dữ liệu JSON không hợp lệ'));
      }
    });
  });
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function sendFile(res, filePath, extra = {}) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ...extra,
  });
  createReadStream(filePath).pipe(res);
}

/** Phục vụ file tĩnh trong `root`; đường dẫn không có đuôi rơi về index.html. */
export function serveStatic(root, pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = path.resolve(root, `.${rel === '/' ? '/index.html' : rel}`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(file).isFile()) return sendFile(res, file);
  } catch { /* rơi xuống 404 */ }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Không tìm thấy');
}
