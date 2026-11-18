# QuizBoo

QuizBoo là trò chơi trắc nghiệm trực tuyến cho lớp học hoặc nhóm bạn. Quản trò tạo phòng và chia sẻ mã gồm 6 ký tự. Người chơi nhập tên và mã phòng để tham gia trên điện thoại hoặc máy tính.

## Bản đang chạy

[Mở QuizBoo trên Cloudflare Workers](https://troll-quiz-room.12a01-quiz.workers.dev/)

## Tính năng

- Soạn câu hỏi hoặc nhập bộ đề từ JSON/CSV. Quản trò có thể sửa bộ câu hỏi trong sảnh chờ và xáo trộn thứ tự trước khi lưu.
- Mỗi câu có từ 2 đến 8 lựa chọn và bộ đếm riêng. Điểm của câu thường giảm từ 1.000 xuống 500 theo thời gian. Với câu có đáp án ẩn, mọi lựa chọn đều sai và đáp án chỉ hiện khi hết giờ.
- Bảng xếp hạng cập nhật trong lúc chơi. Quản trò có thể kết thúc phòng ngay, xem kết quả rồi cho chơi lại.
- Quản trò có thể đăng ký bằng tên người dùng và mật khẩu để mở lại phòng từ thiết bị khác. Phòng tạo khi chưa đăng nhập có thể gắn vào tài khoản từ trình duyệt đã tạo phòng. Tài khoản chưa hỗ trợ khôi phục mật khẩu.
- Có thể dùng ảnh, GIF hoặc video cho câu hỏi và phần công bố đáp án.

## Chạy trên máy

Cần Node.js 22 trở lên và npm. Từ thư mục dự án, chạy trong PowerShell.

```powershell
npm.cmd ci
Copy-Item wrangler.example.jsonc wrangler.jsonc
npm.cmd run db:local
npm.cmd run dev
```

Chỉ cần sao chép cấu hình ở lần đầu. Mở địa chỉ Wrangler in ra, thường là `http://localhost:8787`. Có thể dùng nút **Khám phá quiz mẫu** để tạo phòng thử. Dữ liệu thử lưu trong `.wrangler/`.

Chạy kiểm thử bằng `npm.cmd run check`.

## Triển khai lên Cloudflare

Giao diện và API dùng Cloudflare Workers. D1 lưu phòng, người chơi, điểm và tài khoản. Cấu hình mẫu dùng Workers và D1.

1. Đăng nhập bằng `npx wrangler login` và kiểm tra tài khoản bằng `npx wrangler whoami`.
2. Nếu chưa có cơ sở dữ liệu, chạy `npx wrangler d1 create troll-quiz-db`. Nếu đã có, lấy ID bằng `npx wrangler d1 list`.
3. Sao chép `wrangler.example.jsonc` thành `wrangler.jsonc` nếu chưa có. Điền ID D1 vào mục có binding `DB`.
4. Chạy `npm.cmd run db:remote` để tạo bảng, sau đó chạy `npm.cmd run deploy`.
5. Mở URL `workers.dev` mà Wrangler in ra. Thử đăng ký, tạo phòng và vào chơi bằng cửa sổ ẩn danh.

Khi cập nhật mã nguồn, chạy lại `npm.cmd run deploy`. Nếu phiên bản mới bổ sung bảng trong `schema.sql`, chạy `npm.cmd run db:remote` trước. Dữ liệu thử trên máy và dữ liệu Cloudflare được lưu riêng.

## Ảnh và video

Bạn có thể dùng link HTTPS hoặc để file trong `public/media/` rồi nhập đường dẫn như `/media/anh-cau-hoi.png`. File đặt trong `public/` có thể truy cập công khai.

Để tải file trực tiếp từ trình soạn thảo, bật R2 trên Cloudflare, tạo bucket và thêm binding `MEDIA` vào `wrangler.jsonc`. Mỗi file tải qua ứng dụng tối đa 15 MB. R2 có hạn mức miễn phí dùng chung cho tài khoản và có thể tính phí vượt mức.

## Bộ câu hỏi mẫu

- [JSON mẫu](examples/quiz-mau.json)
- [CSV mẫu](examples/quiz-mau.csv)

Trong JSON, trường `answer` bắt đầu từ 0. Trong CSV, cột `answer` bắt đầu từ 1. Dùng `hidden` trong JSON hoặc `hidden_text` trong CSV để tạo câu có đáp án ẩn.

## Cấu hình riêng

Kho mã dùng `wrangler.example.jsonc` với ID D1 mẫu. Giữ `wrangler.jsonc`, token Cloudflare, khóa quản trò, cookie đăng nhập và dữ liệu D1 trên máy hoặc trong môi trường triển khai.
