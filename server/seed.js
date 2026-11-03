import { get, run, tx, addCashEntry } from './db.js';
import { now } from './util.js';
import { createProduct } from './routes/catalog.js';
import { createPartner } from './routes/partners.js';
import { createInvoice } from './routes/sales.js';

const CATEGORIES = {
  'Đồ uống': [
    ['8934588012228', 'Nước suối Aquafina 500ml', 'chai', 3500, 6000, 240],
    ['8934588063053', 'Pepsi lon 330ml', 'lon', 7000, 11000, 180],
    ['8935049500346', 'Trà xanh không độ 455ml', 'chai', 6500, 10000, 120],
    ['8934563138165', 'Cà phê sữa lon Highlands', 'lon', 11000, 16000, 96],
  ],
  'Bánh kẹo': [
    ['8934680020159', 'Bánh Oreo socola 133g', 'gói', 13000, 19000, 60],
    ['8936036020588', 'Kẹo cao su Doublemint', 'thanh', 2500, 5000, 150],
    ['8934680033074', 'Snack khoai tây vị tự nhiên', 'gói', 8000, 12000, 80],
  ],
  'Mì và đồ khô': [
    ['8934563116019', 'Mì Hảo Hảo tôm chua cay', 'gói', 3200, 4500, 400],
    ['8934563203016', 'Phở bò ăn liền', 'gói', 6500, 9500, 100],
    ['8936136160016', 'Gạo ST25 túi 5kg', 'túi', 145000, 185000, 25],
  ],
  'Gia dụng': [
    ['8934868150012', 'Nước rửa chén Sunlight 750g', 'chai', 26000, 34000, 40],
    ['8934868120015', 'Bột giặt OMO 800g', 'gói', 32000, 42000, 36],
    ['8936017360047', 'Giấy vệ sinh 10 cuộn', 'lốc', 52000, 69000, 4],
  ],
};

/** Dữ liệu mẫu đi qua đúng các hàm nghiệp vụ, nên số liệu demo khớp như dữ liệu thật. */
export function seedDemo(userId) {
  const user = { id: userId, role: 'admin' };
  tx(() => {
    const products = [];
    for (const [category, items] of Object.entries(CATEGORIES)) {
      const categoryId = Number(run('INSERT INTO categories (name) VALUES (?)', category).lastInsertRowid);
      for (const [barcode, name, unit, cost, price, stock] of items) {
        const minStock = stock >= 100 ? 20 : 5;
        const id = createProduct({ barcode, name, unit, cost_price: cost, sale_price: price, stock, min_stock: minStock, category_id: categoryId }, userId);
        products.push(get('SELECT * FROM products WHERE id = ?', id));
      }
    }
    const customers = [
      { name: 'Nguyễn Thị Lan', phone: '0901234567', address: '12 Lê Lợi, Quận 1' },
      { name: 'Trần Văn Bình', phone: '0912345678', address: '45 Hai Bà Trưng, Quận 3' },
      { name: 'Quán cà phê An Nhiên', phone: '0987654321', address: '8 Phan Xích Long, Phú Nhuận' },
    ].map((c) => createPartner('customers', c));
    createPartner('suppliers', { name: 'Công ty TNHH Phân phối Minh Phát', phone: '02838123456', address: 'KCN Tân Bình, TP.HCM' });
    createPartner('suppliers', { name: 'Đại lý Hoàng Gia', phone: '0903111222', address: 'Chợ Bình Tây, Quận 6' });

    addCashEntry({ type: 'in', category: 'Số dư đầu kỳ', amount: 5000000, source: 'manual', note: 'Dữ liệu mẫu', userId, createdAt: daysAgo(14, 7) });

    // Bộ sinh giả ngẫu nhiên cố định để dữ liệu mẫu giống nhau mỗi lần tạo.
    let state = 20261101;
    const rand = (n) => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return Math.floor((state / 4294967296) * n);
    };
    for (let day = 13; day >= 0; day -= 1) {
      const count = 3 + rand(5);
      for (let k = 0; k < count; k += 1) {
        const items = [];
        const lineCount = 1 + rand(4);
        const usedIds = new Set();
        for (let l = 0; l < lineCount; l += 1) {
          const p = products[rand(products.length - 1)];
          if (usedIds.has(p.id)) continue;
          usedIds.add(p.id);
          const qty = 1 + rand(3);
          const { stock } = get('SELECT stock FROM products WHERE id = ?', p.id);
          if (stock - qty >= p.min_stock) items.push({ product_id: p.id, qty }); // chừa lại tồn tối thiểu
        }
        if (!items.length) continue;
        const onCredit = k === 0 && day % 5 === 0;
        createInvoice(
          { items, method: rand(4) === 0 ? 'bank' : 'cash', customer_id: onCredit ? customers[rand(3)] : undefined, paid: onCredit ? 0 : undefined },
          user,
          { createdAt: daysAgo(day, 8 + k) },
        );
      }
    }
  });
}

function daysAgo(days, hour) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  // Không đặt mốc trong tương lai: hôm nay chỉ lùi về giờ hiện tại.
  const target = new Date(d);
  target.setHours(hour, 15, 0, 0);
  return now(target > new Date() ? new Date() : target);
}
