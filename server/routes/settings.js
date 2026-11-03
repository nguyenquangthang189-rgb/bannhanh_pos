import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db, getSettings, saveSetting, tx } from '../db.js';
import { bad, toText, today } from '../util.js';
import { sendFile } from '../http.js';

export function register(r) {
  r.get('/api/settings', () => getSettings());

  r.put('/api/settings', 'admin', ({ body }) => tx(() => {
    const cur = getSettings();
    if (body.store) {
      saveSetting('store', {
        name: toText(body.store.name, 120) || cur.store.name,
        address: toText(body.store.address, 250),
        phone: toText(body.store.phone, 40),
        tax_code: toText(body.store.tax_code, 20),
      });
    }
    if (body.receipt) {
      saveSetting('receipt', {
        title: toText(body.receipt.title, 60) || cur.receipt.title,
        footer: toText(body.receipt.footer, 300),
        show_barcode: Boolean(body.receipt.show_barcode),
      });
    }
    if (body.business) {
      const rate = Number(body.business.tax_rate ?? 0);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw bad('Thuế suất không hợp lệ');
      saveSetting('business', {
        tax_rate: rate,
        allow_negative_stock: Boolean(body.business.allow_negative_stock),
        cashier_can_edit_price: Boolean(body.business.cashier_can_edit_price),
      });
    }
    return getSettings();
  }));

  // Sao lưu nhất quán dù WAL đang mở: VACUUM INTO tạo bản sao rồi gửi cho trình duyệt tải về.
  r.get('/api/backup', 'admin', ({ res }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bannhanh-'));
    const file = path.join(dir, 'backup.db');
    db.prepare('VACUUM INTO ?').run(file);
    res.on('close', () => rmSync(dir, { recursive: true, force: true }));
    sendFile(res, file, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="bannhanh-${today()}.db"`,
      'Cache-Control': 'no-store',
    });
    return undefined;
  });
}
