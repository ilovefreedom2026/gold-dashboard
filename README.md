# Gold Price Scraper — Hướng dẫn cho người dùng (không cần là IT)

Mục tiêu: Chạy dashboard `index.html` và tự động cập nhật dữ liệu giá vàng, bạc và tỷ giá bằng server nhỏ chạy trên máy của bạn.

Các file quan trọng trong thư mục này:
- `index.html` — Giao diện dashboard (mở bằng trình duyệt).
- `server.js` — Server Node.js: lấy dữ liệu từ trang nguồn (scraper) và cung cấp API cho `index.html`.
- `package.json` — Khai báo các thư viện cần cài.
- `run_dashboard.bat` — Script Windows để cài phụ thuộc (nếu cần), khởi động server và mở dashboard.
- `README.md` — Hướng dẫn này.

Yêu cầu (một lần):
1. Cài Node.js (phiên bản LTS). Tải từ: https://nodejs.org và cài bình thường.
2. Mở `File Explorer` đến thư mục nơi chứa các file (ví dụ `c:\Users\T\gold-price-scraper`).

Cách chạy (rất đơn giản):
1. Nhấp đúp vào `run_dashboard.bat` — nó sẽ tự động:
   - Kiểm tra (và cài) các thư viện Node cần thiết (nếu `node_modules` chưa có).
   - Khởi động server và mở `index.html` bằng Chrome nếu có, hoặc bằng trình duyệt mặc định.
2. Chờ khoảng 10–20 giây để server khởi động. Dashboard sẽ cố gắng gọi API `http://localhost:3000/scrape` để lấy dữ liệu.

Lưu ý: Nếu scraper thực tế gặp lỗi (ví dụ trang nguồn thay đổi, hoặc trang chặn bot), server sẽ trả về dữ liệu mẫu (mock) để dashboard vẫn hiển thị giá giả định — điều này giúp dashboard không bị trống.

Kiểm tra nhanh (nếu muốn xem dữ liệu trực tiếp):
- Mở trình duyệt và truy cập: `http://localhost:3000/scrape` — xem JSON trả về.
- Nếu muốn luôn dùng dữ liệu mẫu, truy cập: `http://localhost:3000/mock`.

Cách sửa lỗi cơ bản:
- Nếu `run_dashboard.bat` báo "Node.js not found": hãy cài Node.js và chạy lại.
- Nếu server chạy nhưng `index.html` vẫn hiển thị '-' hoặc không đổi: mở `http://localhost:3000/scrape` để xem server trả gì. Nếu là dữ liệu mẫu thì scraper chưa lấy được dữ liệu thực.
- Nếu bạn muốn dừng server: đóng cửa sổ `Node Server` hoặc dùng Task Manager để dừng node process.

Muốn tôi làm gì tiếp:
- 1) Tinh chỉnh code scraper để tương thích chính xác với trang nguồn cụ thể (tôi có thể cập nhật các selector cho `giavang.org` và các trang khác).
- 2) Thêm ghi log chi tiết hoặc lưu lịch sử vào file.
- 3) Triển khai lên máy chủ (VPS) nếu bạn muốn dashboard hoạt động 24/7.

Nếu bạn muốn, tôi có thể tiếp tục và cập nhật `server.js` để sửa scraper cho trang `giavang.org` — cho biết bạn muốn tôi làm điều đó hay không.