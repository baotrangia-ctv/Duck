# Integrations and configuration

## Environment variables

Defaults below distinguish the runtime fallback from the value prefilled in .env.example.
“Required” describes when the integration can operate, not whether the server can start.

| Group | Variable | Runtime default / example | Required? | Used by / effect |
|---|---|---|---|---|
| Server | PORT | 3030 | No | server.js listen port |
| Server | HOST | 0.0.0.0 | No | Bind address |
| SeaTalk | SEATALK_SIGNING_SECRET | empty | Required off loopback | Enables callback Signature validation; empty accepts unsigned webhooks |
| SeaTalk | SEATALK_APP_ID | empty | With app secret, unless access token supplied | SeaTalk app credentials |
| SeaTalk | SEATALK_APP_SECRET | empty | With app ID, unless access token supplied | Requests app access token |
| SeaTalk | SEATALK_ACCESS_TOKEN | empty | Alternative credential | Pre-issued token; avoids app-token request |
| SeaTalk | SEATALK_API_BASE_URL | https://openapi.seatalk.io | No | SeaTalkClient base URL |
| Chatflow | CHATFLOW_API_URL | runtime empty; example is the project Chatflow URL | For Chatflow | First auto provider when paired with token |
| Chatflow | CHATFLOW_API_TOKEN | empty | For Chatflow | Bearer token for extraction request |
| Extractor | TASK_EXTRACTOR | auto | No | auto, chatflow, compass, or rules |
| Extractor | HOLIDAY_DATES | empty | No | Non-working dates for week-deadline parsing |
| Compass | COMPASS_BASE_URL | https://compass.llm.shopee.io/compass-api/v1 | For Compass | Base URL; code appends /chat/completions |
| Compass | COMPASS_API_KEY | empty | For Compass | Bearer token |
| Compass | COMPASS_MODEL | compass-max | No | Model passed to Compass |
| Google | GOOGLE_SHEETS_SPREADSHEET_ID | empty | For Sheets | Spreadsheet ID or full spreadsheet URL |
| Google | GOOGLE_SHEETS_SHEET_NAME | Sheet1 | No | Tab name used for reads and writes |
| Google | GOOGLE_SHEETS_RANGE | A:I | No | Nine-column write range |
| Google | GOOGLE_SERVICE_ACCOUNT_KEY_PATH | .auth/google-service-account.json | For Sheets | Resolved relative to repo root; service-account JSON key |
| Google | GOOGLE_OAUTH_CLIENT_ID | empty | For login | Google web OAuth client ID |
| Google | GOOGLE_OAUTH_CLIENT_SECRET | empty | For login | Google web OAuth client secret |
| Google | GOOGLE_OAUTH_REDIRECT_URI | http://localhost:3030/auth/google/callback; code uses current PORT when unset | For login | Must match provider redirect configuration |
| Google | GOOGLE_SHEETS_WRITE_ENABLED | false | To write | Only the case-insensitive string true enables writes |
| Auth | AUTH_ALLOWLIST_PATH | .auth/allowlist.json | For dashboard access | Resolved relative to repo root; owner/viewer email lists |
| Auth | AUTH_SESSION_SECRET | unset | No | HMAC key; if unset, a random key is persisted at .auth/session-secret |
| Auth | AUTH_SESSION_TTL_DAYS | 30 | No | Sliding session lifetime |
| Auth | AUTH_DISABLED | false | No | Only exact `true` disables auth; loopback HOST required |

## HTTP endpoints

Dashboard and API routes require a signed session for an account in the current allowlist.
SeaTalk callback signatures are checked only when SEATALK_SIGNING_SECRET is configured; webhook
routes remain public and do not use session cookies. Responses send no CORS headers. Mutating
non-webhook requests with an Origin header must match the Host header. OPTIONS returns 204 with
no CORS headers.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | / | Serve dashboard index | Owner or viewer session |
| GET | /<static path> | Serve a file from public/ | Owner or viewer session |
| GET | /login, /login.html | Serve public login page | Public |
| POST | /callback | SeaTalk callback | Public; optional Signature header check |
| POST | /seatalk/callback | Callback alias | Public; optional Signature header check |
| POST | /webhook/seatalk | Callback alias | Public; optional Signature header check |
| GET | /healthz | Liveness response | Public |
| GET | /auth/login | Start Google sign-in | Public |
| GET | /auth/google/callback | Complete Google sign-in | Public; one-time state and cookie |
| POST | /auth/logout | Clear current session | Owner or viewer session; same-origin |
| GET | /api/me | Current account and role | Owner or viewer session |
| GET | /api/health | Runtime and integration status | Owner or viewer session |
| GET | /api/messages | Current in-memory events | Owner or viewer session |
| GET | /api/stream | Dashboard SSE snapshot and updates | Owner or viewer session; rechecked every 60 s |
| GET | /api/google/status | Service-account and Sheet-access status | Owner or viewer session |
| DELETE | /api/messages | Clear in-memory event list and broadcast clear | Owner session |
| POST | /api/test-message | Create local sample and run extraction with skipSheet | Owner session |
| OPTIONS | * | Empty 204 response | Public |

The default bind is 0.0.0.0. A non-loopback bind requires a nonempty SeaTalk signing secret,
because dashboard authentication does not protect webhook routes. `AUTH_DISABLED=true` is
refused on non-loopback hosts.

## SeaTalk Open Platform

SeaTalkClient uses these POST endpoints:

| Path | Use |
|---|---|
| /auth/app_access_token | Obtain an app token from app_id/app_secret |
| /messaging/v2/single_chat | Send a direct message to an employee_code |
| /messaging/v2/group_chat | Send a group message; thread_id is attached when present |
| /messaging/v2/update | Replace an existing interactive message by message_id |

The app token is cached in SeaTalkClient until near its expiration; a supplied access token
is treated as non-expiring in this process. src/seatalk.js builds interactive_message cards,
plain-text assignment notices, and quick-pick values.

The README claims group chats cannot accept interactive_message and describes a DM card plus
thread text. Current sendConfirmationCard passes buildConfirmationMessage to sendReply using
the source target; group targets use /messaging/v2/group_chat. A source test explicitly checks
an interactive confirmation in the source group thread. Verify platform behavior against the
deployed SeaTalk app before relying on the README flow; see [gotchas](gotchas.md).

## Google Sheets

| Column | Value | Notes |
|---|---|---|
| A | ID | Numeric max(ID)+1 |
| B | Task | Task content |
| C | PIC | Email |
| D | Deadline | DD/MM/YYYY |
| E | Priority | P0/P1/P2 |
| F | Status | TODO, IN PROGRESS, DONE, or NOT DO; new tasks default to TODO |
| G | CreatedAt | ISO timestamp |
| H | UpdatedAt | ISO timestamp; defaults to CreatedAt |
| I | Creator | Lowercase email of the task creator; may be empty when SeaTalk supplies no email |

Add the `Creator` header manually in cell I1 of the live sheet. The application does not write
or alter the header row. The client reads task rows from A2:I (header assumed on row 1), and IDs
from A2:A. Appends and updates use valueInputOption=USER_ENTERED. appendQueue serializes reads/writes in one
GoogleSheetsClient instance; it is not a distributed lock for multiple server instances.

For written tasks, the PIC or the Creator may edit Priority, Deadline, and Status. The Sheet
row's Creator value is authoritative for ID-based and card updates; an empty Creator cell leaves
edit permission with the PIC only. A Creator's card-confirmation DM is routed to the PIC.

New tasks remain TODO after the PIC receives their assignment card. Only the PIC email stored in
column C may acknowledge the card; the Creator cannot acknowledge unless they are also the PIC.
Acknowledgement re-reads the row and changes TODO to IN PROGRESS, refreshing UpdatedAt. Repeated
clicks and rows already in IN PROGRESS, DONE, or NOT DO do not change the Sheet row.

GoogleSheetsClient obtains access tokens from the service-account JWT bearer grant, using only
the spreadsheets scope. The key file defaults to `.auth/google-service-account.json`; keep it
private and out of Git. The service-account `client_email` must be shared on the spreadsheet
with Editor access. `/api/google/status` checks access with a lightweight spreadsheet metadata
request and caches the result for 60 seconds. A 403 returns a share instruction; a 404 asks the
operator to check the spreadsheet ID and sharing. Writes remain disabled unless
GOOGLE_SHEETS_WRITE_ENABLED=true. The GOOGLE_OAUTH_* variables below are used only for dashboard login.

## Dashboard login

Google OAuth is used only for sign-in with `openid email` scopes; it does not grant Sheets API
access. Configure the Web OAuth client ID/secret and callback URI, then maintain
`.auth/allowlist.json` with `{ "owners": ["..."], "viewers": ["..."] }`. The role is looked
up on every request, so edits take effect without restart. Missing or malformed allowlists deny
access; after a valid load, an invalid edit keeps the last valid list until a valid replacement
is saved. The signed session cookie contains email and timestamps, not role. It renews when less
than half its lifetime remains. HTTPS redirect URIs add the Secure cookie flag.

`AUTH_DISABLED=true` provides a local owner identity (`local@dev`) only when HOST is
`127.0.0.1`, `localhost`, or `::1`. If AUTH_SESSION_SECRET is unset, the server writes a random
32-byte key to `.auth/session-secret` with mode 0600 so cookies remain valid after restarts.
