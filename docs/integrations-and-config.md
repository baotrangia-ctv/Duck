# Integrations and configuration

## Environment variables

Defaults below distinguish the runtime fallback from the value prefilled in .env.example.
“Required” describes when the integration can operate, not whether the server can start.

| Group | Variable | Runtime default / example | Required? | Used by / effect |
|---|---|---|---|---|
| Server | PORT | 3030 | No | server.js listen port |
| Server | HOST | 0.0.0.0 | No | Bind address |
| SeaTalk | SEATALK_SIGNING_SECRET | empty | No | Enables callback Signature validation when nonempty |
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
| Google | GOOGLE_SHEETS_RANGE | A:H | No | Eight-column write range |
| Google | GOOGLE_OAUTH_CLIENT_ID | empty | For OAuth | Web OAuth client ID |
| Google | GOOGLE_OAUTH_CLIENT_SECRET | empty | For OAuth | Web OAuth client secret |
| Google | GOOGLE_OAUTH_REDIRECT_URI | http://localhost:3030/auth/google/callback; code uses current PORT when unset | For OAuth | Must match provider redirect configuration |
| Google | GOOGLE_OAUTH_TOKEN_PATH | .oauth/google-token.json | No | Resolved relative to repo root; stores OAuth tokens |
| Google | GOOGLE_SHEETS_WRITE_ENABLED | false | To write | Only the case-insensitive string true enables writes |

## HTTP endpoints

The HTTP handler has no dashboard/API authentication. Callback signatures are checked only
when SEATALK_SIGNING_SECRET is configured. JSON responses and SSE set
Access-Control-Allow-Origin: *; OPTIONS allows GET, POST, DELETE, and OPTIONS with Content-Type
and Signature headers.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | / | Serve dashboard index | None |
| GET | /<static path> | Serve a file from public/ | None |
| POST | /callback | SeaTalk callback | Optional Signature header check |
| POST | /seatalk/callback | Callback alias | Optional Signature header check |
| POST | /webhook/seatalk | Callback alias | Optional Signature header check |
| GET | /api/health | Runtime and integration status | None |
| GET | /api/messages | Current in-memory events | None |
| DELETE | /api/messages | Clear in-memory event list and broadcast clear | None |
| GET | /api/stream | Dashboard SSE snapshot and updates | None |
| POST | /api/test-message | Create local sample and run extraction with skipSheet | None |
| GET | /auth/google | Start Google OAuth | None |
| GET | /auth/google/callback | Complete OAuth callback | OAuth state/code validation |
| GET | /api/google/status | Google configuration/authorization status | None |
| POST | /api/google/disconnect | Delete local OAuth token file | None |
| OPTIONS | * | CORS preflight | None |

The default bind is 0.0.0.0, and /api/messages exposes raw event payloads. Treat the
unauthenticated API, wildcard CORS, and bind address as deployment risks.

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
| F | Status | IN PROGRESS, DONE, or NOT DO |
| G | CreatedAt | ISO timestamp |
| H | UpdatedAt | ISO timestamp; defaults to CreatedAt |

The client reads task rows from A2:H (header assumed on row 1), and IDs from A2:A. Appends
and updates use valueInputOption=USER_ENTERED. appendQueue serializes reads/writes in one
GoogleSheetsClient instance; it is not a distributed lock for multiple server instances.

OAuth requests spreadsheet, openid, email, and profile scopes. The token file defaults to
.oauth/google-token.json, is written with mode 0600, and is deleted by disconnect. Keep it
private and out of Git. Writes are disabled unless GOOGLE_SHEETS_WRITE_ENABLED=true.
