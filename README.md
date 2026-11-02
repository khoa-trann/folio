# Folio — app đọc sách online/offline

Chạy (cần Node 18+, không cần cài thêm gói):

```bash
node server.js
```

Mở http://localhost:3000

## Nguồn sách

| Mục | Nguồn | Ghi chú |
| --- | --- | --- |
| Miễn phí | Project Gutenberg | Lấy từ file danh mục CSV chính thức. Mỗi thể loại có danh sách sách chọn sẵn (`seeds` trong `sources.js`), sau đó lọc thêm theo chủ đề. |
| Miễn phí | Standard Ebooks | Sách mới phát hành (bản biên tập đẹp, đã hết bản quyền). |
| Trả phí | Apple Books (cửa hàng Mỹ) | Bảng xếp hạng sách trả phí theo thể loại, giá USD. Nút "Mua" mở Apple Books; Folio không xử lý thanh toán. |

Thể loại sách miễn phí: Phát triển bản thân, Văn học kinh điển, Triết học, Trinh thám, Viễn tưởng, Thiếu nhi, Lịch sử & tiểu sử, Thơ & kịch.
Chuyên mục sách trả phí: Phát triển bản thân, Kinh doanh, Tiểu thuyết, Trinh thám, Khoa học, Nuôi dạy con.

## Tìm sách (mục "tìm sách")

Tìm cùng lúc trong mọi nguồn mở và trên thị trường:

| Nguồn | Có gì | Trong app |
| --- | --- | --- |
| Project Gutenberg | ~78.000 sách hết bản quyền (tìm trong file danh mục tải về máy chủ) | Đọc trọn, tải offline, dịch VI |
| Wikisource tiếng Việt | Văn học Việt Nam hết bản quyền (Nam Cao, Truyện Kiều…) | Đọc trọn (tự ghép các chương), tải offline |
| Internet Archive (qua Open Library) | Bản scan sách hết bản quyền | Đọc văn bản OCR trong app + link xem bản scan gốc |
| Open Library | 20+ triệu đầu sách, gồm sách còn bản quyền | Giới thiệu sách (dịch VI), link mượn miễn phí, giá Apple Books, link tìm mua trên Tiki, Fahasa, Shopee, Google Play Sách, Amazon Kindle |

Bộ lọc: Tất cả / Chỉ sách đọc miễn phí / Sách trên thị trường. Không nhập từ khoá thì có thể duyệt toàn bộ kho Gutenberg theo thể loại.
Kết quả cũng hiển thị dạng slide và tự tải thêm khi cuộn gần cuối.

## Trình đọc (giống Apple Books)

- **Aa**: giao diện Sáng / Giấy / Tối / Đen, 4 phông chữ, cỡ chữ, giãn dòng, khổ chữ, căn đều. Chỉ áp dụng trong trang đọc.
- **☰**: mục lục theo chương, danh sách đánh dấu trang, ghi chú; tìm trong sách (⌕ hoặc Ctrl+F).
- **☆**: đánh dấu trang (phím `b`).
- Bôi đen chữ → tô sáng 4 màu, ghi chú, sao chép, dịch nhanh đoạn đó. Xuất ghi chú ra file .txt.
- Thanh dưới: chương hiện tại, số phút còn lại trong chương, % đã đọc. Thanh công cụ tự ẩn khi cuộn xuống.

## Tủ sách

- Tiếp tục đọc, Đang đọc, Muốn đọc (nút “+ Muốn đọc” trên slide), Đã đọc xong (tự đánh dấu khi đọc tới cuối), Đã tải xuống, Ghi chú & đánh dấu.
- Mục tiêu đọc mỗi ngày (5/15/30/60 phút), chuỗi ngày liên tiếp, biểu đồ 7 ngày.
- **Sách của tôi**: nhập file **EPUB / TXT không khoá DRM** (chọn file hoặc kéo thả). File được đọc và lưu ngay trong trình duyệt; sách có DRM sẽ được báo là không mở được. PDF chưa hỗ trợ.
- Dữ liệu cá nhân (tiến độ, ghi chú…) lưu trên từng thiết bị, không đồng bộ giữa các máy.

## Tính năng

- **Mỗi sách một slide**: cuộn chuột / vuốt / phím ↑ ↓ để chuyển. Mỗi lần sang slide, bìa sách hiện dần từ trên xuống và chữ trượt xuống vào vị trí.
- **Lọc theo thể loại** bằng các nút ở slide đầu; tìm theo tên sách, tác giả, chủ đề.
- **EN / VI**: bản tiếng Việt được dịch máy (Google Translate) — tên sách, lời mở đầu, giới thiệu sách trả phí dịch sẵn; nội dung sách dịch dần khi đọc và lưu trong `data/vi/`.
- **Đọc offline**: "(Tải xuống · EN/VI)" lưu sách vào trình duyệt (IndexedDB), bìa trong cache của Service Worker.
- **Cập nhật mỗi 3 ngày**: thêm 2 sách miễn phí mỗi thể loại + sách mới của Standard Ebooks, làm mới bảng xếp hạng sách trả phí. Ép cập nhật ngay: `POST /api/refresh`.

Dữ liệu nằm trong `data/` (catalog.json, pg_catalog.csv, texts/, covers/, vi/). Các thông số (chu kỳ, số sách mỗi lần, chuyên mục) ở đầu `server.js` và trong `sources.js`.
