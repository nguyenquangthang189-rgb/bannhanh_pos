import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpError, bad, toText } from '../util.js';

const isWindows = process.platform === 'win32';

// Gửi byte thô qua spooler để máy in nhận nguyên lệnh ESC/POS, không qua driver đồ họa.
const WINDOWS_RAW_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] data, int len, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Khong mo duoc may in, ma loi " + Marshal.GetLastWin32Error());
    try {
      var di = new DOCINFO { pDocName = "BanNhanh", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("StartDoc loi " + Marshal.GetLastWin32Error());
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length) throw new Exception("WritePrinter loi " + Marshal.GetLastWin32Error());
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
[RawPrinter]::Send($env:BN_PRINTER, [IO.File]::ReadAllBytes($env:BN_FILE))
`;

function powershell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `PowerShell thoát với mã ${code}`));
    });
    child.stdin.end(script);
  });
}

async function listPrinters() {
  if (isWindows) {
    const out = await powershell('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress');
    const parsed = out.trim() ? JSON.parse(out) : [];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return new Promise((resolve) => {
    execFile('lpstat', ['-e'], (err, stdout) => resolve(err ? [] : stdout.split('\n').map((s) => s.trim()).filter(Boolean)));
  });
}

async function sendToInstalledPrinter(printer, data) {
  const printers = await listPrinters();
  if (!printers.includes(printer)) throw bad(`Không tìm thấy máy in "${printer}" trên máy chủ`);
  const dir = mkdtempSync(path.join(tmpdir(), 'bannhanh-print-'));
  const file = path.join(dir, 'job.bin');
  try {
    writeFileSync(file, data);
    if (isWindows) {
      await powershell(WINDOWS_RAW_SCRIPT, { BN_PRINTER: printer, BN_FILE: file });
    } else {
      await new Promise((resolve, reject) => {
        execFile('lp', ['-d', printer, '-o', 'raw', file], (err) => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Máy in mạng chỉ nằm trong LAN; chặn địa chỉ khác để endpoint này không thành cổng gửi dữ liệu ra ngoài. */
export function isPrivateIpv4(host) {
  if (net.isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function sendToNetworkPrinter(host, port, data) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 5000 });
    socket.on('connect', () => socket.end(data));
    socket.on('timeout', () => socket.destroy(new Error('Hết thời gian chờ')));
    socket.on('error', reject);
    socket.on('close', (hadError) => { if (!hadError) resolve(); });
  });
}

export function register(r) {
  r.get('/api/print/printers', async () => {
    try {
      return { printers: await listPrinters() };
    } catch (err) {
      throw new HttpError(502, `Không đọc được danh sách máy in: ${err.message}`);
    }
  });

  r.post('/api/print/raw', async ({ body }) => {
    const data = Buffer.from(String(body.data ?? ''), 'base64');
    if (!data.length) throw bad('Không có dữ liệu in');
    try {
      if (body.transport === 'network') {
        const host = toText(body.host, 45);
        const port = Number(body.port ?? 9100);
        if (!isPrivateIpv4(host)) throw bad('Địa chỉ máy in phải là IPv4 trong mạng nội bộ, ví dụ 192.168.1.100');
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('Cổng máy in không hợp lệ');
        await sendToNetworkPrinter(host, port, data);
      } else if (body.transport === 'windows') {
        await sendToInstalledPrinter(toText(body.printer, 200), data);
      } else {
        throw bad('Kiểu kết nối máy in không hợp lệ');
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Không gửi được tới máy in: ${err.message}`);
    }
    return { ok: true, bytes: data.length };
  });
}
