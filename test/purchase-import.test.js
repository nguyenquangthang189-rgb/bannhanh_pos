import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'bannhanh-import-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { createAppServer } = await import('../server/app.js');
const { db } = await import('../server/db.js');
const { parseNumber } = await import('../server/routes/purchase-import.js');
const { freeformLines } = await import('../server/lib/invoice-text.js');
const { stopOcr } = await import('../server/lib/ocr.js');

let server;
let base;
const jar = { cookie: '' };
const cashierJar = { cookie: '' };

async function call(j, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(j.cookie ? { Cookie: j.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) j.cookie = setCookie.split(';')[0];
  return { status: res.status, data: await res.json() };
}
async function ok(promise) {
  const r = await promise;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

/** Tạo file .xlsx tối thiểu đúng cấu trúc zip thật. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(dirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, eocd]);
}

function xlsx(sheetRowsXml, shared = []) {
  return zip({
    'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="An" sheetId="1" state="hidden" r:id="rId9"/><sheet name="Nhap" sheetId="2" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetRowsXml}</sheetData></worksheet>`,
  });
}
const b64 = (buf) => Buffer.from(buf).toString('base64');
const upload = (filename, buf, j = jar) => call(j, 'POST', '/api/purchases/import/file', { filename, data: b64(buf) });
const inline = (ref, s) => `<c r="${ref}" t="inlineStr"><is><t>${s}</t></is></c>`;
const num = (ref, n) => `<c r="${ref}"><v>${n}</v></c>`;

let A;
let B;

before(async () => {
  server = createAppServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await ok(call(jar, 'POST', '/api/auth/setup', { store_name: 'Shop', full_name: 'Chủ', username: 'owner', password: 'matkhau1' }));
  await ok(call(jar, 'POST', '/api/users', { username: 'thungan', full_name: 'TN', password: 'matkhau2', role: 'cashier' }));
  await ok(call(cashierJar, 'POST', '/api/auth/login', { username: 'thungan', password: 'matkhau2' }));
  A = (await ok(call(jar, 'POST', '/api/products', { name: 'Áo thun đỏ', barcode: '8930001', sale_price: 100000, stock: 10 }))).id;
  B = (await ok(call(jar, 'POST', '/api/products', { name: 'Đường cát', code: 'DUONG', unit: 'kg', sale_price: 30000, stock: 5 }))).id;
  await ok(call(jar, 'POST', '/api/products', { name: 'Pepsi lon 330ml', unit: 'lon', sale_price: 11000 }));
});
after(() => {
  server.closeAllConnections();
  server.close();
  stopOcr();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('đọc số kiểu Việt Nam', () => {
  assert.equal(parseNumber('12.000'), 12000);
  assert.equal(parseNumber('1.234.567 đ'), 1234567);
  assert.equal(parseNumber('12,000'), 12000);
  assert.equal(parseNumber('1,5'), 1.5);
  assert.equal(parseNumber('1.5'), 1.5);
  assert.equal(parseNumber(2500), 2500);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
});

test('xlsx: tìm tiêu đề, khớp hàng, cảnh báo, bỏ dòng tổng và không ghi vào kho', async () => {
  const rows = [
    `<row r="1">${inline('A1', 'PHIẾU GIAO HÀNG &amp; THANH TOÁN')}</row>`,
    '<row r="2"/>',
    `<row r="3"><c r="A3" t="s"><v>0</v></c>${inline('B3', 'Mã hàng')}${inline('C3', 'Tên hàng')}${inline('D3', 'ĐVT')}${inline('E3', 'S.Lượng')}${inline('F3', 'Đơn giá')}${inline('G3', 'Thành tiền')}${inline('H3', 'Giá bán')}</row>`,
    `<row r="4">${inline('A4', '8930001')}${inline('C4', 'Áo đỏ tên khác')}${num('E4', 5)}${inline('F4', '95.000')}</row>`,
    `<row r="5">${inline('B5', 'duong')}${inline('C5', 'Đường')}${inline('E5', '1,5')}${num('F5', 18000)}${num('G5', 27000)}</row>`,
    `<row r="6">${inline('C6', 'DUONG CAT')}${num('E6', 2)}${num('G6', 50000)}</row>`,
    `<row r="7">${inline('C7', 'Áo thun đỏ loại 2')}${num('E7', 3)}${num('F7', 80000)}${num('G7', 999999)}</row>`,
    `<row r="8">${inline('C8', 'Công tắc điện')}${num('E8', 0)}${num('H8', 15000)}</row>`,
    `<row r="9">${inline('C9', 'Tổng cộng')}${num('E9', 11)}${num('G9', 1000)}</row>`,
  ].join('');
  const stockBefore = db.prepare('SELECT SUM(stock) AS s FROM products').get().s;
  const res = await ok(upload('hang.xlsx', xlsx(rows, ['Mã vạch'])));
  assert.equal(res.lines.length, 5);
  const [byBarcode, byCode, byName, fuzzy, none] = res.lines;

  assert.equal(byBarcode.match, 'exact');
  assert.equal(byBarcode.product.id, A);
  assert.equal(byBarcode.cost, 95000);

  assert.equal(byCode.match, 'exact');
  assert.equal(byCode.product.id, B);
  assert.equal(byCode.qty, 1.5);
  assert.deepEqual(byCode.warnings, []);

  assert.equal(byName.match, 'name');
  assert.equal(byName.product.id, B);
  assert.equal(byName.cost, 25000, 'thiếu đơn giá thì lấy thành tiền chia số lượng');

  assert.equal(fuzzy.match, 'fuzzy');
  assert.equal(fuzzy.product, null, 'khớp gần đúng không được tự chọn');
  assert.equal(fuzzy.candidates[0].id, A);
  assert.match(fuzzy.warnings[0], /khác số lượng nhân đơn giá/);

  assert.equal(none.name, 'Công tắc điện');
  assert.equal(none.match, 'none');
  assert.equal(none.qty, null);
  assert.equal(none.sale_price, 15000);
  assert.deepEqual(none.warnings, ['Thiếu số lượng', 'Thiếu đơn giá']);

  assert.equal(db.prepare('SELECT SUM(stock) AS s FROM products').get().s, stockBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 0);

  // Bản nháp đã duyệt đi qua API nhập hàng bình thường và cập nhật kho.
  const purchase = await ok(call(jar, 'POST', '/api/purchases', { items: [{ product_id: byBarcode.product.id, qty: byBarcode.qty, cost: byBarcode.cost }] }));
  assert.equal(purchase.total, 475000);
});

test('csv: dấu chấm phẩy, BOM và bảng mã Windows', async () => {
  const utf8 = Buffer.from('﻿Tên hàng;Số lượng;Đơn giá\n"Đường cát";2;"20.000"\n');
  const res = await ok(upload('a.csv', utf8));
  assert.equal(res.lines[0].product.id, B);
  assert.equal(res.lines[0].cost, 20000);

  const ansi = Buffer.concat([Buffer.from('T'), Buffer.from([0xea]), Buffer.from('n hang,SL\nX,1\n')]);
  const res2 = await ok(upload('b.csv', ansi));
  assert.equal(res2.lines[0].name, 'X');
});

test('file lỗi được báo rõ', async () => {
  assert.match((await upload('cu.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).data.error, /\.xlsx/);
  assert.match((await upload('hong.xlsx', Buffer.from('khong phai zip nhe, chi la chu thoi'))).data.error, /Không đọc được/);
  assert.match((await upload('a.csv', Buffer.from('cot1,cot2\n1,2\n'))).data.error, /Không tìm thấy bảng hàng/);
  assert.equal((await upload('a.pdf', Buffer.from('x'))).status, 400);
  assert.equal((await upload('a.csv', Buffer.from('Tên hàng,SL\nX,1\n'), cashierJar)).status, 403);
});

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const sendImage = (file, j = jar) => call(j, 'POST', '/api/purchases/import/image', { data: b64(readFileSync(path.join(FIXTURES, file))) });
const EXPECTED = [
  ['Pepsi lon 330ml', 'lon', 24, 7000],
  ['Mì Hảo Hảo tôm chua cay', 'gói', 100, 3200],
  ['Nước rửa chén Sunlight 750g', 'chai', 12, 26000],
  ['Sữa tươi Vinamilk 1L', 'hộp', 6, 29000],
];

// Ảnh mẫu do test/fixtures/make-invoice-images.ps1 tạo: bảng có kẻ, ảnh giống ảnh chụp, và bảng không kẻ.
for (const file of ['hoa-don-in.png', 'hoa-don-chup.png', 'hoa-don-khong-ke.png']) {
  test(`ảnh ${file}: OCR tại máy đọc đúng dòng hàng, chiết khấu và tổng tiền`, async () => {
    const res = await ok(sendImage(file));
    assert.equal(res.source, 'image');
    assert.deepEqual(res.lines.map((l) => [l.name, l.unit, l.qty, l.cost]), EXPECTED);
    assert.equal(res.discount, 4000);
    assert.equal(res.doc_total, 970000, 'lấy Tổng thanh toán, không lấy Tổng cộng trước chiết khấu');
    assert.match(res.note, /PG-1024/);
    assert.ok(res.ocr_confidence >= 70, `độ tin cậy ${res.ocr_confidence}`);
    assert.equal(res.lines[0].match, 'name', 'dòng Pepsi khớp với hàng có sẵn qua tên');
    assert.equal(res.lines[1].match, 'none');
  });
}

test('ảnh: chỉ quản trị viên, chỉ nhận JPG/PNG, ảnh không có bảng hàng báo rõ', async () => {
  assert.equal((await sendImage('hoa-don-in.png', cashierJar)).status, 403);
  assert.equal((await call(jar, 'POST', '/api/purchases/import/image', { data: b64(Buffer.from('GIF89a....')) })).status, 400);
  const blank = (await import('../server/lib/png.js')).encodePngGray({ width: 300, height: 200, data: new Uint8Array(300 * 200).fill(255) });
  const res = await call(jar, 'POST', '/api/purchases/import/image', { data: b64(blank) });
  assert.equal(res.status, 422);
  assert.match(res.data.error, /Không tìm thấy dòng hàng/);
});

test('không có dòng tiêu đề: đọc dòng theo các số cuối và bộ ba SL × đơn giá = thành tiền', () => {
  const lines = freeformLines([
    'CỬA HÀNG ABC',
    '1 Pepsi lon 330ml lon 24 7.000 168 000',
    '2. Đường cát trắng kg 1,5 20.000 30.000',
    'Bánh quy 3 15.000',
    'Tổng cộng 213.000',
  ].join('\n'), parseNumber);
  assert.deepEqual(lines.slice(0, 3).map((l) => [l.name, l.unit, l.qty, l.unit_price, l.line_total, l.confirmed]), [
    ['Pepsi lon 330ml', 'lon', 24, 7000, 168000, true],
    ['Đường cát trắng', 'kg', 1.5, 20000, 30000, true],
    ['Bánh quy', '', 3, 15000, null, false],
  ]);
});
