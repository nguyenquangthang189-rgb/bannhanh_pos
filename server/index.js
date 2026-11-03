import { createAppServer } from './app.js';
import { DB_PATH } from './db.js';

const PORT = Number(process.env.PORT) || 3210;
// Mặc định chỉ máy này truy cập được. Đặt HOST=0.0.0.0 để các quầy khác trong LAN dùng chung.
const HOST = process.env.HOST || '127.0.0.1';

createAppServer().listen(PORT, HOST, () => {
  console.log(`BanNhanh đang chạy tại http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Dữ liệu lưu ở: ${DB_PATH}`);
});
