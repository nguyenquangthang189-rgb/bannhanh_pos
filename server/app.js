import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, readJson, sendJson, serveStatic } from './http.js';
import { HttpError } from './util.js';
import * as auth from './routes/auth.js';
import * as catalog from './routes/catalog.js';
import * as partners from './routes/partners.js';
import * as sales from './routes/sales.js';
import * as inventory from './routes/inventory.js';
import * as cashbook from './routes/cashbook.js';
import * as reports from './routes/reports.js';
import * as settings from './routes/settings.js';
import * as print from './routes/print.js';
import * as system from './routes/system.js';
import * as purchaseImport from './routes/purchase-import.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const router = new Router();
for (const mod of [auth, catalog, partners, sales, inventory, cashbook, reports, settings, print, system, purchaseImport]) mod.register(router);

/** Chặn trang web lạ gửi request ghi dữ liệu bằng cookie của người dùng (CSRF, DNS rebinding). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function handleApi(req, res, url) {
  const found = router.match(req.method, url.pathname);
  if (!found) throw new HttpError(404, 'API không tồn tại');
  if (req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'Yêu cầu không cùng nguồn');
  const { route, params } = found;
  const user = auth.currentUser(req);
  if (route.access !== 'public') {
    if (!user) throw new HttpError(401, 'Vui lòng đăng nhập');
    if (route.access === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Bạn không có quyền thực hiện thao tác này');
  }
  const body = req.method === 'GET' ? {} : await readJson(req);
  const result = await route.handler({ req, res, params, query: Object.fromEntries(url.searchParams), body, user });
  if (result !== undefined) sendJson(res, 200, result);
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
      return serveStatic(PUBLIC_DIR, url.pathname, res);
    }
    try {
      await handleApi(req, res, url);
    } catch (err) {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Lỗi máy chủ, vui lòng thử lại' });
    }
  });
}
