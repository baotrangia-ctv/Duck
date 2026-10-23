# Alpha Intel · SeaTalk inbox

Website local để nhận callback từ SeaTalk Open Platform Bot và hiển thị nội dung tin nhắn trên màn hình theo thời gian thực.

## Chạy local

Yêu cầu Node.js 18+.

```powershell
cd C:\_Code\craftland\AlphaIntel
Copy-Item .env.example .env
npm start
```

Mở <http://localhost:3030>. Đây chỉ là URL dashboard local; SeaTalk không thể gọi callback vào `localhost`.

Để nhận tin nhắn thật, callback URL trong SeaTalk phải là HTTPS public, ví dụ `https://<domain-public>/callback`. Khi chạy local, dùng một tunnel/reverse proxy trỏ về `http://127.0.0.1:3030` rồi dùng URL public đó trong SeaTalk. Server mặc định bind `0.0.0.0`; có thể đổi bằng biến `HOST`.

## Kết nối SeaTalk

1. Trong SeaTalk Open Platform, mở app Bot và vào `Event Callback`.
2. Dùng URL callback `https://<public-domain>/callback` khi server đã được đưa lên domain public.
3. SeaTalk sẽ gửi event `event_verification`; server tự trả lại object `event` chứa `seatalk_challenge`.
4. Khi người dùng nhắn tin cho bot, event `message_from_bot_subscriber` sẽ được nhận và hiển thị trên Activity feed.

Để bật kiểm tra chữ ký, đặt `SEATALK_SIGNING_SECRET` trong `.env` bằng Signing Secret của SeaTalk rồi khởi động lại server. Chữ ký được kiểm tra theo công thức SeaTalk dùng trong adapter mẫu: SHA-256 của raw request body nối với signing secret.

Để bot gửi card xác nhận, cần thêm `SEATALK_APP_ID` và `SEATALK_APP_SECRET` lấy từ **Basic Info & Credentials** của app Bot. Có thể dùng `SEATALK_ACCESS_TOKEN` nếu hệ thống của bạn đã cấp sẵn token. Bot tự lấy/cache App Access Token khi cần.

## Trích xuất task và ghi vào Google Sheet

Khi nhận `message_from_bot_subscriber` (hoặc event message tương đương), server lấy nội dung từ payload SeaTalk và trích xuất task từ message + metadata `mentioned_list`:

| Cột | Field |
|---|---|
| A | ID — số nguyên tự tăng, server tự tạo |
| B | Task — nội dung công việc |
| C | PIC — email người được giao |
| D | Deadline — định dạng `DD/MM/YYYY` |
| E | Priority — theo `TaskPriorityPolicy` hiện tại |
| F | Status — `TODO`, `IN PROGRESS`, `DONE` hoặc `NOT DO`; mặc định `TODO` |
| G | CreatedAt — thời điểm nhận/xác nhận task |
| H | UpdatedAt — mặc định bằng `CreatedAt` |
| I | Creator — email viết thường của người tạo task |

Thêm thủ công header `Creator` vào ô I1 của Google Sheet đang dùng. Server không ghi header.

Sau khi extract trong group chat, bot gửi phần nội dung PIC, Nội dung Task, Deadline, Priority vào thread gốc và gửi interactive card có nút **Confirm** vào chat riêng của người tạo task. SeaTalk group-chat API hiện không nhận `interactive_message`, nên đây là cách giữ được cả thread context và nút Confirm. Nếu không gửi được chat riêng, người dùng có thể reply `Confirm` trong thread. Chỉ khi Confirm thì task mới được ghi vào Google Sheet; sau khi ghi thành công, bot gửi interactive card giao task trực tiếp tới PIC. ID được tính bằng `max(ID hiện có) + 1`; các lần ghi được serialize để tránh cấp trùng ID khi có nhiều event đồng thời.

Task mới có trạng thái `TODO` trong draft, card xác nhận, Sheet và card giao việc gửi cho PIC. Việc nhận DM không đổi trạng thái. PIC bấm **Xác nhận nhận task** để đổi Sheet sang `IN PROGRESS`; Creator không thể bấm thay PIC trừ khi họ cũng là PIC. Nút acknowledgement đọc lại dòng Sheet nên vẫn xử lý được sau khi server khởi động lại. Nếu task đã có trạng thái khác `TODO`, server giữ nguyên trạng thái đó.

Nếu người dùng tiếp tục @mention bot trong cùng thread, extractor nhận draft và lịch sử gần đây làm context, chỉ cập nhật các field được yêu cầu rồi gửi lại card Confirm. Nếu task đã được ghi, lần Confirm sau sẽ update đúng dòng cũ trong Google Sheet thay vì tạo dòng mới. Callback `interactive_message_click` được xử lý riêng, không bị extract thành task mới.

Các rule extract được tách thành file Markdown để dễ chỉnh sửa:

- rules/PIC_POLICY.md — cách xác định PIC và email người gửi/người được mention.
- rules/DEADLINE_POLICY.md — cách quy đổi ngày tương đối thành DD/MM/YYYY.
- rules/TASK_PRIORITY_POLICY.md — quy ước P0/P1/P2.

Các cụm `tuần sau`/`trong tuần sau` dùng ngày làm việc hợp lệ cuối cùng của tuần kế tiếp. Mặc định thứ Bảy và Chủ Nhật là ngày nghỉ; có thể thêm ngày lễ bằng biến `HOLIDAY_DATES`, ví dụ `HOLIDAY_DATES=01/05/2026,02/09/2026`. Khi không có deadline, hệ thống ưu tiên lấy Priority để suy ra ngày: P0 là hôm nay, P1 sau 3 ngày lịch, P2 sau 7 ngày lịch; nếu không có tín hiệu Priority thì dùng P2 và deadline sau 7 ngày.

Server đọc các file này khi khởi động và ghép chúng vào EXTRACTION_PROMPT; sau khi sửa rule cần restart server.

Mặc định `TASK_EXTRACTOR=auto` sẽ ưu tiên Chatflow đang có của project, sau đó dùng Compass LLM giống project `Claude`. Nếu chưa cấu hình AI, parser vẫn xử lý được tin nhắn có nhãn rõ ràng như `PIC: an@example.com; deadline: 30/09; nội dung công việc: cập nhật dashboard`.

Đặt các biến Google Sheets và service account trong `.env`:

```env
TASK_EXTRACTOR=auto
HOLIDAY_DATES=01/05/2026,02/09/2026
CHATFLOW_API_URL=https://ai.insea.io/api/chatflows/26607/run?stream=true
CHATFLOW_API_TOKEN=your_chatflow_token
GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id_or_full_url
GOOGLE_SHEETS_SHEET_NAME=Sheet1
GOOGLE_SHEETS_RANGE=A:I
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=.auth/google-service-account.json
GOOGLE_SHEETS_WRITE_ENABLED=true
GOOGLE_OAUTH_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-web-client-secret
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3030/auth/google/callback
AUTH_ALLOWLIST_PATH=.auth/allowlist.json
AUTH_SESSION_TTL_DAYS=30
# Có thể đặt AUTH_SESSION_SECRET; nếu để trống server sẽ lưu secret ngẫu nhiên trong .auth/.
AUTH_SESSION_SECRET=

# SeaTalk outbound messaging for confirmation cards/thread replies.
SEATALK_APP_ID=your_seatalk_app_id
SEATALK_APP_SECRET=your_seatalk_app_secret
# Optional alternative to APP_ID/APP_SECRET:
# SEATALK_ACCESS_TOKEN=your_seatalk_access_token
SEATALK_API_BASE_URL=https://openapi.seatalk.io
```

Trong Google Cloud, bật **Google Sheets API**, tạo service account rồi tải JSON key vào `.auth/google-service-account.json` (hoặc đường dẫn đặt trong `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`). Share Google Sheet với email `client_email` trong key và cấp quyền **Editor**. Không đưa key vào Git.

Tạo OAuth Client ID loại **Web application** để đăng nhập dashboard. Thêm callback `http://localhost:3030/auth/google/callback` vào **Authorized redirect URIs** (hoặc dùng callback HTTPS của domain khi deploy) và đặt cùng giá trị trong `GOOGLE_OAUTH_REDIRECT_URI`. Luồng đăng nhập chỉ yêu cầu scope `openid email`.

Mở dashboard bằng đúng host và cổng trong `GOOGLE_OAUTH_REDIRECT_URI`. Trang `/login` tự chuyển sang Google và cho chọn tài khoản; nút đăng nhập vẫn dùng được nếu cần thử lại. Sau khi đăng xuất, trang đăng nhập sẽ đứng yên. Nếu đăng nhập lỗi, xem `Mã lỗi` trên trang và dòng `Google login:` trong log server để xác định bước cần kiểm tra.

Nếu Google báo `redirect_uri_mismatch`, lỗi xuất hiện trên trang Google trước khi server nhận callback. So sánh dòng khởi động `Google login: redirect URI sent to Google = ...` với **Authorized redirect URIs** của OAuth Client ID loại **Web application** đang dùng trong `GOOGLE_OAUTH_CLIENT_ID`; scheme, host, port và path phải khớp chính xác. Mục **error details** trên trang lỗi của Google cho biết `redirect_uri` chính xác đã nhận. Thay đổi trong Cloud Console có thể mất vài phút mới có hiệu lực.

Tạo `.auth/allowlist.json` từ `allowlist.example.json`, rồi điền email vào `owners` hoặc `viewers`. Owner có thể xóa lịch sử và gửi tin nhắn thử; viewer chỉ xem dashboard. `.auth/` đã được ignore khỏi Git. Nếu `AUTH_SESSION_SECRET` để trống, server tạo secret ngẫu nhiên trong `.auth/session-secret` để giữ phiên đăng nhập qua lần restart. Luồng local thông thường vẫn dùng allowlist và Google login với `GOOGLE_OAUTH_REDIRECT_URI` khớp chính xác; xem log server khi cần kiểm tra redirect URI.

Sau khi service account có quyền truy cập Sheet, task chỉ được ghi khi người dùng bấm **Confirm** trên card và `GOOGLE_SHEETS_WRITE_ENABLED=true`. Dashboard hiển thị trạng thái cấu hình và quyền truy cập của service account.

Nếu dashboard báo chưa truy cập được Sheet, kiểm tra `GOOGLE_SHEETS_SPREADSHEET_ID` và share Sheet cho đúng `client_email` với quyền **Editor**. Nếu Google báo Sheets API chưa được bật, mở **APIs & Services → Library**, tìm **Google Sheets API** trong project của service account rồi bấm **Enable**.

Google Sheet dùng chín cột theo đúng thứ tự `ID`, `Task`, `PIC`, `Deadline`, `Priority`, `Status`, `CreatedAt`, `UpdatedAt`, `Creator` trong vùng `GOOGLE_SHEETS_RANGE`. `GOOGLE_SHEETS_SPREADSHEET_ID` có thể là ID thuần hoặc full URL của spreadsheet. Khi bật ghi Sheet, task chỉ được append sau khi Confirm; các draft đã ghi sẽ được update đúng dòng khi người dùng chỉnh sửa và Confirm lại. Với task đã ghi, PIC hoặc Creator có thể đổi Priority, Deadline và Status bằng tin nhắn quote, Task ID hoặc các nút trên card cập nhật. Nếu cột Creator trống thì chỉ PIC được chỉnh sửa. Server chống ghi trùng khi SeaTalk gửi lại cùng `event_id` hoặc `message_id`. Nút **Gửi tin nhắn thử** chỉ kiểm tra extraction và không gửi card/ghi dòng demo vào Sheet.

Hiện tại chế độ ghi Sheet vẫn tắt mặc định bằng `GOOGLE_SHEETS_WRITE_ENABLED=false`. Dashboard vẫn hiển thị bảng **Thông tin sau khi extract payload** realtime. Khi muốn bật ghi, đặt biến này thành `true` và restart server.

Dashboard local thông thường vẫn dùng allowlist và Google login; cấu hình `.auth/allowlist.json`, OAuth Client ID loại **Web application** và `GOOGLE_OAUTH_REDIRECT_URI` như hướng dẫn trên. `AUTH_DISABLED=true` chỉ là lối tắt tạm thời cho kiểm tra tự động trên máy local; biến này bỏ qua đăng nhập, chỉ được phép với `HOST` loopback và server sẽ hiện cảnh báo rõ ràng. Nếu bind ra mạng ngoài loopback, cần đặt `SEATALK_SIGNING_SECRET`; webhook SeaTalk vẫn là endpoint server-to-server và không dùng cookie đăng nhập.

Nếu dashboard hiển thị `local@dev` hoặc banner đỏ, `AUTH_DISABLED=true` đang được bật. Trong PowerShell chạy `Remove-Item Env:AUTH_DISABLED -ErrorAction SilentlyContinue`, xóa dòng `AUTH_DISABLED` khỏi `.env` nếu có rồi restart server. Không dán giá trị biến này vào nơi khác.

Nếu muốn dùng Compass trực tiếp (theo mẫu project `Claude`), đặt `TASK_EXTRACTOR=compass`, `COMPASS_API_KEY`, `COMPASS_BASE_URL` và `COMPASS_MODEL`.

## Endpoint

- `GET /` — giao diện dashboard.
- `GET /login` — trang đăng nhập.
- `GET /healthz` — liveness, không cần đăng nhập.
- `POST /callback` — SeaTalk callback URL.
- `POST /seatalk/callback` và `POST /webhook/seatalk` — alias callback.
- `GET /auth/login` — bắt đầu Google sign-in; callback là `GET /auth/google/callback`.
- `POST /auth/logout` — đăng xuất phiên hiện tại.
- `GET /api/me`, `/api/messages`, `/api/stream`, `/api/health`, `/api/google/status` — cần phiên owner hoặc viewer.
- `POST /api/test-message` và `DELETE /api/messages` — chỉ owner.

`GET /api/health` cần đăng nhập và trả trạng thái extractor, outbound SeaTalk và Google Sheets (`taskExtractor`, `taskExtractionConfigured`, `seatalkConfigured`, `googleSheetsWriteEnabled`, `googleSheetsConfigured`, `googleSheetsAuthorized`, `googleServiceAccountEmail`). Dùng `GET /healthz` cho liveness không cần đăng nhập.

Lịch sử hiện chỉ lưu trong bộ nhớ và sẽ reset khi restart server; đây là chủ ý để bản đầu tập trung vào việc nhận và quan sát callback.

Tài liệu tham khảo: [SeaTalk Open Platform](https://open.seatalk.io/docs/introduction-to-seatalk-open-platform) và [SeaTalk CSBot callback adapter](https://github.com/seatalk-io/cs-bot/tree/main/cs_bot/adapters/sop_bot).
