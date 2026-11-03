# BanNhanh: phần mềm bán hàng và kế toán cho cửa hàng bán lẻ

Chạy trên máy của bạn, dữ liệu lưu tại chỗ trong một file SQLite. Không cần cài thư viện nào ngoài Node.js 22.13 trở lên.

## Chạy

Trên Windows, bấm đúp `start.bat`, hoặc:

```bash
npm start
```

Mở http://localhost:3210. Lần đầu, phần mềm yêu cầu tạo tài khoản chủ cửa hàng (không có mật khẩu mặc định).

### Shortcut khởi động nhanh

Bấm đúp `tao-shortcut.bat`, hoặc vào Cài đặt > Shortcut > Tạo shortcut (đăng nhập quản trị viên, trên máy đang chạy phần mềm). Biểu tượng BanNhanh sẽ có trên Desktop và trong Start Menu.

Bấm vào biểu tượng để bật phần mềm và mở trình duyệt; nếu phần mềm đang chạy thì chỉ mở trình duyệt. Phần mềm chạy trong cửa sổ thu nhỏ ở thanh tác vụ, đóng cửa sổ đó là tắt phần mềm. Nếu chuyển thư mục phần mềm, hãy tạo lại shortcut.

### Đóng gói để cài lên máy khác

Bấm đúp `dong-goi.bat` trên máy này (cần Node.js và đã chạy `npm install`). Kết quả là file `dist/BanNhanh-<phiên bản>-win-x64.zip` chứa sẵn Node.js trong thư mục `runtime` cùng toàn bộ thư viện, nên máy mới không cần cài gì. Gói không chứa thư mục `data` (dữ liệu cửa hàng).

Trên máy mới (Windows 10/11 64-bit): giải nén vào một thư mục cố định như `C:\BanNhanh`, bấm `tao-shortcut.bat`, rồi mở bằng biểu tượng BanNhanh. Hướng dẫn chi tiết, cả cách chuyển dữ liệu và cập nhật, nằm trong file `HUONG-DAN-CAI-DAT.txt` của gói.

Biến môi trường: `PORT` (mặc định 3210), `HOST` (mặc định 127.0.0.1), `DB_PATH` (mặc định `data/bannhanh.db`).

Để nhiều quầy trong cùng mạng LAN dùng chung, chạy máy chủ với `HOST=0.0.0.0` và mở cổng trong tường lửa. Phần mềm chỉ dùng HTTP, nên chỉ mở trong mạng nội bộ tin cậy, không đưa thẳng ra Internet.

## Chức năng

- **Bán hàng:** nhiều hóa đơn song song, tìm không dấu, giảm giá theo dòng hoặc cả đơn (đ/%), tiền mặt/chuyển khoản/thẻ, bán nợ, tính tiền thừa. Phím tắt: F2 tìm hàng, F3 tìm khách, F4 tiền khách đưa, F8 hóa đơn mới, F9 thanh toán.
- **Hàng hóa:** nhóm hàng, mã vạch, dịch vụ, thẻ kho, in tem mã vạch, nhập/xuất CSV.
- **Kho:** nhập hàng với giá vốn bình quân gia quyền, tạo phiếu nhập từ file Excel/CSV hoặc ảnh hóa đơn, kiểm kho, cảnh báo sắp hết hàng.
- **Hóa đơn:** in lại, hủy, trả hàng từng phần.
- **Công nợ:** khách hàng và nhà cung cấp, phân bổ vào chứng từ cũ nhất trước, hủy phiếu thì khôi phục công nợ.
- **Sổ quỹ:** phiếu thu/chi, tồn quỹ theo tiền mặt, ngân hàng, thẻ.
- **Báo cáo:** lãi lỗ, doanh thu theo ngày, theo hàng hóa, theo thu ngân, tồn kho, cuối ngày, xuất CSV.
- **Phân quyền:** quản trị viên và thu ngân. Thu ngân không xem được giá vốn, sổ quỹ, báo cáo lãi lỗ.

## Tạo phiếu nhập từ file hoặc ảnh

Vào Nhập hàng > Từ file Excel hoặc ảnh. Phần mềm đọc chứng từ thành bản nháp, khớp từng dòng với danh mục, rồi bạn duyệt trước khi lưu. Dòng khớp theo mã vạch, mã hàng hoặc đúng tên được chọn sẵn. Dòng còn lại phải được chọn, tạo hàng mới hoặc xóa thì mới lưu được phiếu.

- **Excel (.xlsx) và CSV:** chạy tại máy, không cần Internet. File cần dòng tiêu đề có cột Tên hàng hoặc Mã hàng, và Số lượng; nên có thêm Đơn giá. Có nút tải file mẫu. File `.xls` đời cũ cần lưu lại thành `.xlsx`.
- **Ảnh hóa đơn:** đọc chữ bằng OCR Tesseract ngay trên máy, không cần Internet, không dùng AI, không mất phí. Phần mềm tìm dòng tiêu đề của bảng (Tên hàng, Số lượng, Đơn giá...) rồi xếp chữ vào từng cột như với Excel; nếu không thấy tiêu đề, nó đọc từng dòng theo các số ở cuối dòng. Kết quả phụ thuộc chất lượng ảnh: chụp thẳng, đủ sáng, rõ nét. Hóa đơn in máy đọc tốt hơn chữ viết tay; chữ viết tay hầu như không đọc được. Cần chạy `npm install` một lần; `start.bat` tự làm việc này.

## Máy quét mã vạch

| Loại | Cách dùng |
| --- | --- |
| USB/Bluetooth kiểu bàn phím (phổ biến nhất) | Cắm là dùng, không cần bấm vào ô nhập. Đặt máy quét gửi phím Enter sau mã. Tắt Unikey khi quét. |
| Cổng COM/USB-Serial | Cài đặt > Máy in và máy quét > Kết nối cổng COM (Chrome hoặc Edge). |
| Camera | Nút camera ở màn hình bán hàng. Chỉ chạy trên localhost hoặc HTTPS. Trên Windows cần Internet để tải thư viện quét. |

Quét ở màn hình Bán hàng để thêm vào hóa đơn, ở Hàng hóa để mở hoặc tạo hàng, ở Nhập hàng và Kiểm kho để thêm dòng, ở Hóa đơn để mở hóa đơn từ mã in trên giấy.

## Máy in hóa đơn

Cấu hình tại Cài đặt > Máy in và máy quét, lưu riêng cho từng máy tính. Hỗ trợ khổ 58 mm và 80 mm.

| Kiểu kết nối | Khi nào dùng |
| --- | --- |
| Qua driver Windows | Dễ nhất, mọi máy in. Có hộp thoại in; thêm tham số `--kiosk-printing` cho Chrome để bỏ hộp thoại. |
| In thẳng (RAW) | Máy in USB đã cài driver, gắn trên máy chạy máy chủ. Không hiện hộp thoại. |
| Mạng LAN/WiFi | Máy in có IP, thường cổng 9100. Chỉ chấp nhận IPv4 nội bộ. |
| Cổng COM/Bluetooth | Web Serial, cần Chrome hoặc Edge. |
| USB trực tiếp | WebUSB. Trên Windows phải đổi driver sang WinUSB bằng Zadig. |

Mặc định, hóa đơn được in dạng ảnh nên giữ đúng dấu tiếng Việt trên mọi máy in ESC/POS, không phụ thuộc bảng mã. Chế độ "Chữ" nhanh hơn nhưng không có dấu. Ngăn kéo tiền mở qua cổng RJ11 của máy in khi thanh toán tiền mặt, nếu bật tùy chọn này.

## Sao lưu

Cài đặt > Sao lưu để tải một bản sao dữ liệu. Phục hồi: tắt phần mềm, chép file sao lưu đè lên `data/bannhanh.db`, xóa các file `-wal` và `-shm` nếu có, rồi mở lại.

## Giới hạn hiện tại

- Không phát hành hóa đơn điện tử và không kết nối cơ quan thuế. Báo cáo là số liệu quản trị, không thay thế sổ sách kế toán thuế.
- Không có trả hàng cho nhà cung cấp và không hủy được phiếu khách trả hàng.
- Chỉ một chi nhánh, chưa có đồng bộ đám mây hay bán khi mất kết nối tới máy chủ.

## Cấu trúc mã nguồn

```
server/         API Node.js thuần (node:http, node:sqlite)
  routes/       auth, catalog, partners, sales, inventory, cashbook, reports, settings, print
public/js/      giao diện ES modules, không cần bước build
  devices/      scanner, printer, escpos, receipt, barcode
  pages/        từng màn hình
test/           kiểm thử nghiệp vụ: npm test
```
