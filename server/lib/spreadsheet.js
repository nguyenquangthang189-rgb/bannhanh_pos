// Đọc .xlsx và .csv thành các mảng dòng, không cần thư viện ngoài. .xlsx là file zip chứa XML.
import zlib from 'node:zlib';
import { bad } from '../util.js';

const MAX_UNZIPPED = 64 * 1024 * 1024; // chặn file zip bung ra quá lớn

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not zip');
  const files = new Map();
  let total = 0;
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n -= 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad directory');
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED });
    total += data.length;
    if (total > MAX_UNZIPPED) throw bad('File Excel quá lớn');
    files.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) => s.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g, (_, name, dec, hex) => (
  name ? ENTITIES[name] : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16))
));
const attr = (attrs, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
const textRuns = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');

function columnIndex(ref) {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function readSheet(xml, shared) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    for (const c of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const type = attr(c[1], 't');
      const body = c[2] ?? '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textRuns(body);
      else if (type === 'str') value = decodeXml(v ?? '');
      else if (type === 'b' || type === 'e') value = '';
      else if (v !== undefined) value = Number(v);
      const ref = attr(c[1], 'r');
      row[ref ? columnIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows;
}

/** Trả về danh sách sheet đang hiện, mỗi sheet là mảng các dòng. */
export function readXlsx(buf) {
  let files;
  try {
    files = unzip(buf);
  } catch (err) {
    if (err.status) throw err;
    throw bad('Không đọc được file Excel này. Hãy mở bằng Excel rồi lưu lại dạng .xlsx');
  }
  const workbook = files.get('xl/workbook.xml')?.toString('utf8');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!workbook || !rels) throw bad('File này không phải bảng tính Excel');
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));
  const targets = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    if (attr(m[1], 'state') === 'hidden') continue;
    const target = targets.get(attr(m[1], 'r:id'));
    const xml = target && files.get(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    if (xml) sheets.push(readSheet(xml.toString('utf8'), shared));
  }
  return sheets;
}

/** CSV từ Excel có thể là UTF-8 hoặc bảng mã Windows tiếng Việt. */
export function readCsv(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1258').decode(buf);
  }
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return [rows];
}
