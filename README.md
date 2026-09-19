# Alpha Intel · SeaTalk inbox

Website local để nhận callback từ SeaTalk Open Platform Bot và hiển thị nội dung tin nhắn trên màn hình theo thời gian thực.

## Chạy local

Yêu cầu Node.js 18+.

```powershell
cd C:\_Code\craftland\AlphaIntel
Copy-Item .env.example .env
npm start
```

Mở <http://localhost:3030>.

## Kết nối SeaTalk

1. Trong SeaTalk Open Platform, mở app Bot và vào `Event Callback`.
2. Dùng URL callback `https://<public-domain>/callback` khi server đã được đưa lên domain public.
3. SeaTalk sẽ gửi event `event_verification`; server tự trả lại object `event` chứa `seatalk_challenge`.
4. Khi người dùng nhắn tin cho bot, event `message_from_bot_subscriber` sẽ được nhận và hiển thị trên Activity feed.

Để bật kiểm tra chữ ký, đặt `SEATALK_SIGNING_SECRET` trong `.env` bằng Signing Secret của SeaTalk rồi khởi động lại server. Chữ ký được kiểm tra theo công thức SeaTalk dùng trong adapter mẫu: SHA-256 của raw request body nối với signing secret.

## Trích xuất task và ghi vào Google Sheet

Khi nhận `message_from_bot_subscriber` (hoặc event message tương đương), server lấy nội dung từ payload SeaTalk và trích xuất task từ message + metadata `mentioned_list`:

| Cột | Field |
|---|---|
| A | ID — số nguyên tự tăng, server tự tạo |
| B | Task — nội dung công việc |
| C | PIC — email người được giao |
| D | Deadline — định dạng `DD/MM/YYYY` |
| E | Priority — theo `TaskPriorityPolicy` hiện tại |
| F | Status — `IN PROGRESS`, `DONE` hoặc `NOT DO`; mặc định `IN PROGRESS` |
| G | CreatedAt — thời điểm nhận/xác nhận task |
| H | UpdatedAt — mặc định bằng `CreatedAt` |

Dashboard cũng hiển thị payload sau extract. ID được tính bằng `max(ID hiện có) + 1`; các lần ghi được serialize để tránh cấp trùng ID khi có nhiều event đồng thời. Flow hiện tại không hỏi xác nhận, không gọi `Tao_cong_viec`, không lên lịch reminder và không escalation.

Các rule extract được tách thành file Markdown để dễ chỉnh sửa:

- rules/PIC_POLICY.md — cách xác định PIC và email người gửi/người được mention.
- rules/DEADLINE_POLICY.md — cách quy đổi ngày tương đối thành DD/MM/YYYY.
- rules/TASK_PRIORITY_POLICY.md — quy ước P0/P1/P2.

Server đọc các file này khi khởi động và ghép chúng vào EXTRACTION_PROMPT; sau khi sửa rule cần restart server.

Mặc định `TASK_EXTRACTOR=auto` sẽ ưu tiên Chatflow đang có của project, sau đó dùng Compass LLM giống project `Claude`. Nếu chưa cấu hình AI, parser vẫn xử lý được tin nhắn có nhãn rõ ràng như `PIC: an@example.com; deadline: 30/09; nội dung công việc: cập nhật dashboard`.

Đặt các biến Google Sheets và OAuth trong `.env`:

```env
TASK_EXTRACTOR=auto
CHATFLOW_API_URL=https://ai.insea.io/api/chatflows/26607/run?stream=true
CHATFLOW_API_TOKEN=your_chatflow_token
GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id_or_full_url
GOOGLE_SHEETS_SHEET_NAME=Sheet1
GOOGLE_SHEETS_RANGE=A:H
GOOGLE_OAUTH_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-web-client-secret
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3030/auth/google/callback
GOOGLE_OAUTH_TOKEN_PATH=.oauth/google-token.json
GOOGLE_SHEETS_WRITE_ENABLED=true
```

Trong Google Cloud, bật **Google Sheets API**, cấu hình **OAuth consent screen**, rồi tạo **OAuth Client ID → Web application**. Thêm chính xác `http://localhost:3030/auth/google/callback` vào **Authorized redirect URIs**. Nếu dùng domain public, thay URI này bằng callback HTTPS của domain đó.

Khởi động server rồi mở dashboard và bấm **Kết nối Google**. Đăng nhập bằng chính tài khoản Google có quyền **Editor** trên Sheet. Server chỉ lưu OAuth token trong `.oauth/google-token.json`; file này đã được ignore khỏi Git và không lưu mật khẩu Google. Sau khi OAuth thành công, các task đang chờ xác thực sẽ được ghi lại tự động.

Nếu Google trả lỗi `Google Sheets API has not been used ... or it is disabled`, mở **APIs & Services → Library**, tìm `Google Sheets API` trong đúng project của OAuth client và bấm **Enable**. Nếu OAuth consent screen đang ở chế độ Testing, thêm tài khoản đăng nhập vào danh sách **Test users**.

Google Sheet phải có tám cột theo đúng thứ tự `ID`, `Task`, `PIC`, `Deadline`, `Priority`, `Status`, `CreatedAt`, `UpdatedAt` trong vùng `GOOGLE_SHEETS_RANGE`. `GOOGLE_SHEETS_SPREADSHEET_ID` có thể là ID thuần hoặc full URL của spreadsheet. Khi bật ghi Sheet, mỗi tin nhắn hợp lệ sẽ được append vào dòng mới. Server chống ghi trùng khi SeaTalk gửi lại cùng `event_id` hoặc `message_id`. Nút **Gửi tin nhắn thử** chỉ kiểm tra extraction và không ghi dòng demo vào Sheet.

Hiện tại chế độ ghi Sheet vẫn tắt mặc định bằng `GOOGLE_SHEETS_WRITE_ENABLED=false`. Dashboard vẫn hiển thị bảng **Thông tin sau khi extract payload** realtime. Khi muốn bật ghi, đặt biến này thành `true`, restart server và bấm **Kết nối Google**.

Nếu muốn dùng Compass trực tiếp (theo mẫu project `Claude`), đặt `TASK_EXTRACTOR=compass`, `COMPASS_API_KEY`, `COMPASS_BASE_URL` và `COMPASS_MODEL`.

## Endpoint

- `GET /` — giao diện dashboard.
- `POST /callback` — SeaTalk callback URL.
- `POST /seatalk/callback` và `POST /webhook/seatalk` — alias callback.
- `GET /api/messages` — danh sách event đang nằm trong bộ nhớ.
- `GET /api/stream` — kênh SSE để cập nhật dashboard realtime.
- `GET /auth/google` — bắt đầu đăng nhập Google OAuth.
- `GET /auth/google/callback` — callback OAuth của Google.
- `GET /api/google/status` — trạng thái cấu hình và tài khoản Google đang kết nối.
- `POST /api/google/disconnect` — xóa OAuth token local.
- `POST /api/test-message` — tạo một event mẫu local.
- `DELETE /api/messages` — xóa lịch sử hiện tại.

`GET /api/health` trả thêm trạng thái extractor và Google Sheets (`taskExtractor`, `taskExtractionConfigured`, `googleSheetsWriteEnabled`, `googleSheetsConfigured`, `googleSheetsAuthorized`, `googleAccountEmail`).

Lịch sử hiện chỉ lưu trong bộ nhớ và sẽ reset khi restart server; đây là chủ ý để bản đầu tập trung vào việc nhận và quan sát callback.

Tài liệu tham khảo: [SeaTalk Open Platform](https://open.seatalk.io/docs/introduction-to-seatalk-open-platform) và [SeaTalk CSBot callback adapter](https://github.com/seatalk-io/cs-bot/tree/main/cs_bot/adapters/sop_bot).
