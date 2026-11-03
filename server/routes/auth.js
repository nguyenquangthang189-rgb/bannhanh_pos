import { randomBytes, scryptSync, createHash, timingSafeEqual } from 'node:crypto';
import { all, get, run, tx, saveSetting, getSettings } from '../db.js';
import { HttpError, bad, conflict, notFound, now, required, toText } from '../util.js';
import { seedDemo } from '../seed.js';

const SESSION_MS = 14 * 24 * 3600 * 1000;
const COOKIE = 'bn_sid';
const failures = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, password_hash: scryptSync(password, salt, 64).toString('hex') };
}

function checkPassword(user, password) {
  const hash = Buffer.from(scryptSync(password, user.salt, 64).toString('hex'));
  const stored = Buffer.from(user.password_hash);
  return hash.length === stored.length && timingSafeEqual(hash, stored);
}

function validPassword(password) {
  if (typeof password !== 'string' || password.length < 6) throw bad('Mật khẩu phải có ít nhất 6 ký tự');
  return password;
}

const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

function startSession(res, userId) {
  const token = randomBytes(32).toString('hex');
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', tokenHash(token), userId, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

export function currentUser(req) {
  const match = (req.headers.cookie ?? '').match(new RegExp(`(?:^|; )${COOKIE}=([a-f0-9]+)`));
  if (!match) return null;
  const row = get(
    `SELECT u.id, u.username, u.full_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    tokenHash(match[1]), Date.now(),
  );
  return row ? { ...row } : null;
}

const hasUsers = () => Boolean(get('SELECT 1 AS x FROM users LIMIT 1'));

function createUser({ username, full_name, password, role }) {
  const name = required(username, 'tên đăng nhập');
  if (!/^[\w.@-]{3,40}$/.test(name)) throw bad('Tên đăng nhập chỉ gồm chữ không dấu, số và . _ - @ (3-40 ký tự)');
  if (get('SELECT 1 AS x FROM users WHERE username = ?', name)) throw conflict('Tên đăng nhập đã tồn tại');
  if (!['admin', 'cashier'].includes(role)) throw bad('Vai trò không hợp lệ');
  const { salt, password_hash } = hashPassword(validPassword(password));
  const { lastInsertRowid } = run(
    'INSERT INTO users (username, full_name, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?)',
    name, required(full_name, 'họ tên'), password_hash, salt, role, now(),
  );
  return Number(lastInsertRowid);
}

export function register(r) {
  r.get('/api/auth/state', 'public', ({ req }) => ({ needsSetup: !hasUsers(), user: currentUser(req) }));

  // Tài khoản chủ cửa hàng được tạo ở lần chạy đầu, nên phần mềm không có mật khẩu mặc định.
  r.post('/api/auth/setup', 'public', ({ body, res }) => {
    const userId = tx(() => {
      if (hasUsers()) throw new HttpError(403, 'Hệ thống đã được thiết lập');
      const id = createUser({ ...body, role: 'admin' });
      const store = { ...getSettings().store, name: required(body.store_name, 'tên cửa hàng') };
      saveSetting('store', store);
      return id;
    });
    if (body.demo) seedDemo(userId);
    startSession(res, userId);
    return { ok: true };
  });

  r.post('/api/auth/login', 'public', ({ req, body, res }) => {
    const username = toText(body.username, 40);
    const key = `${req.socket.remoteAddress}|${username.toLowerCase()}`;
    const record = failures.get(key);
    if (record && record.count >= MAX_FAILS && Date.now() - record.at < LOCK_MS) {
      throw new HttpError(429, 'Đăng nhập sai quá nhiều lần, vui lòng thử lại sau 5 phút');
    }
    const user = get('SELECT * FROM users WHERE username = ? AND active = 1', username);
    if (!user || typeof body.password !== 'string' || !checkPassword(user, body.password)) {
      const fresh = record && Date.now() - record.at < LOCK_MS;
      failures.set(key, { count: fresh ? record.count + 1 : 1, at: Date.now() });
      throw new HttpError(401, 'Sai tên đăng nhập hoặc mật khẩu');
    }
    failures.delete(key);
    startSession(res, user.id);
    return { ok: true };
  });

  r.post('/api/auth/logout', 'public', ({ req, res }) => {
    const match = (req.headers.cookie ?? '').match(new RegExp(`(?:^|; )${COOKIE}=([a-f0-9]+)`));
    if (match) run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(match[1]));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  r.post('/api/auth/password', ({ user, body }) => {
    const full = get('SELECT * FROM users WHERE id = ?', user.id);
    if (typeof body.current !== 'string' || !checkPassword(full, body.current)) throw bad('Mật khẩu hiện tại không đúng');
    const { salt, password_hash } = hashPassword(validPassword(body.password));
    run('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?', salt, password_hash, user.id);
    return { ok: true };
  });

  r.get('/api/users', 'admin', () => all('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id'));

  r.post('/api/users', 'admin', ({ body }) => ({ id: createUser(body) }));

  r.put('/api/users/:id', 'admin', ({ params, body }) => tx(() => {
    const target = get('SELECT * FROM users WHERE id = ?', params.id);
    if (!target) throw notFound();
    const role = body.role ?? target.role;
    const active = body.active === undefined ? target.active : (body.active ? 1 : 0);
    if (!['admin', 'cashier'].includes(role)) throw bad('Vai trò không hợp lệ');
    if (target.role === 'admin' && target.active && (role !== 'admin' || !active)) {
      const { n } = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1");
      if (n <= 1) throw conflict('Phải còn ít nhất một quản trị viên đang hoạt động');
    }
    run('UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?', toText(body.full_name) || target.full_name, role, active, target.id);
    if (body.password) {
      const { salt, password_hash } = hashPassword(validPassword(body.password));
      run('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?', salt, password_hash, target.id);
    }
    if (body.password || !active) run('DELETE FROM sessions WHERE user_id = ?', target.id);
    return { ok: true };
  }));
}
