import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createTaskExtractor } from "./src/task-extractor.js";
import { GoogleSheetsClient } from "./src/google-sheets.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");

function loadEnvFile() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

loadEnvFile();
const port = Number.parseInt(process.env.PORT || "3030", 10);
const signingSecret = process.env.SEATALK_SIGNING_SECRET || "";
const chatflowUrl = process.env.CHATFLOW_API_URL || "";
const chatflowToken = process.env.CHATFLOW_API_TOKEN || "";
const googleSheetsWriteEnabled = String(process.env.GOOGLE_SHEETS_WRITE_ENABLED || "false").toLowerCase() === "true";
const googleOAuthRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${port}/auth/google/callback`;
const googleOAuthTokenPath = resolve(root, process.env.GOOGLE_OAUTH_TOKEN_PATH || ".oauth/google-token.json");
const taskExtractor = createTaskExtractor({
  provider: process.env.TASK_EXTRACTOR || "auto",
  chatflowUrl,
  chatflowToken,
  compassBaseUrl: process.env.COMPASS_BASE_URL || "https://compass.llm.shopee.io/compass-api/v1",
  compassApiKey: process.env.COMPASS_API_KEY || "",
  compassModel: process.env.COMPASS_MODEL || "compass-max",
});
const googleSheets = new GoogleSheetsClient({
  spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "",
  sheetName: process.env.GOOGLE_SHEETS_SHEET_NAME || "Sheet1",
  range: process.env.GOOGLE_SHEETS_RANGE || "A:H",
  oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  oauthRedirectUri: googleOAuthRedirectUri,
  tokenPath: googleOAuthTokenPath,
});
const maxMessages = 100;
const messages = [];
const clients = new Set();
const oauthStates = new Map();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function getHeader(request, name) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value || "";
}

function signaturesMatch(rawBody, receivedSignature) {
  if (!signingSecret) return true;
  if (!receivedSignature) return false;

  const expected = createHash("sha256")
    .update(Buffer.concat([rawBody, Buffer.from(signingSecret, "latin1")]))
    .digest("hex");
  const received = Buffer.from(receivedSignature.trim().toLowerCase(), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  return (
    received.length === expectedBuffer.length &&
    timingSafeEqual(received, expectedBuffer)
  );
}

function toIsoTime(timestamp) {
  if (typeof timestamp !== "number") return new Date().toISOString();
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parseSeaTalkEvent(payload) {
  const eventType = payload?.event_type || "unknown";
  const event = payload?.event || {};
  const message = event?.message || payload?.message || {};
  const sender = event?.sender || event?.user || event?.from || {};
  const text =
    message?.text?.content ||
    message?.text?.plain_text ||
    message?.plain_text ||
    message?.content ||
    event?.text?.content ||
    event?.text?.plain_text ||
    event?.content ||
    "";

  if ([
    "message_from_bot_subscriber",
    "new_bot_subscriber_message",
    "new_mentioned_message_received_from_group_chat",
    "message",
  ].includes(eventType)) {
    const messageId = event?.message_id || message.message_id || message.id || payload?.event_id || null;
    return {
      kind: "message",
      title: typeof text === "string" && text.trim() ? text.trim() : "Tin nhắn không có nội dung văn bản",
      text: typeof text === "string" ? text.trim() : "",
      sender: sender.name || event.employee_name || event.sender_name || event.employee_code || sender.employee_code || "Không rõ người gửi",
      senderId: sender.seatalk_id || event.seatalk_id || event.sender_id || sender.employee_code || event.employee_code || null,
      employeeCode: sender.employee_code || event.employee_code || null,
      messageId,
      groupId: event.group_id || event.group?.group_id || null,
      messageType: message.tag || "text",
      eventType,
    };
  }

  if (eventType === "new_bot_subscriber") {
    return {
      kind: "subscriber",
      title: "Có người đăng ký bot mới",
      sender: event.employee_code || "Không rõ người dùng",
      messageType: "system",
      eventType,
    };
  }

  return {
    kind: eventType === "event_verification" ? "verification" : "event",
    title: eventType === "event_verification" ? "SeaTalk đang xác minh callback URL" : "Sự kiện SeaTalk mới",
    sender: event.employee_code || "SeaTalk",
    messageType: message.tag || "event",
    eventType,
  };
}

function initialProcessingState() {
  const sheetStatus = !googleSheetsWriteEnabled
    ? "paused"
    : !googleSheets.isConfigured()
      ? "not_configured"
      : !googleSheets.isAuthorized()
        ? "auth_required"
        : "queued";
  return {
    extraction: {
      status: taskExtractor.configured ? "queued" : "rules",
      provider: taskExtractor.provider,
      source: "",
      taskId: null,
      task: null,
      pic: null,
      deadline: null,
      taskContent: null,
      priority: null,
      taskStatus: "IN PROGRESS",
      createdAt: null,
      updatedAt: null,
      error: "",
    },
    sheet: {
      status: sheetStatus,
      rowNumber: null,
      updatedRange: "",
      error: sheetStatus === "auth_required" ? "Chưa kết nối Google" : "",
    },
  };
}

function addMessage(payload, receivedAt = new Date().toISOString()) {
  const parsed = parseSeaTalkEvent(payload);
  const id = payload?.event_id || parsed.messageId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const existing = messages.find((message) => message.id === id);
  if (existing) return { record: existing, duplicate: true };

  const record = {
    id,
    receivedAt,
    timestamp: toIsoTime(payload?.timestamp),
    appId: payload?.app_id || "",
    parsed,
    payload,
    processing: parsed.kind === "message" ? initialProcessingState() : null,
  };

  messages.unshift(record);
  if (messages.length > maxMessages) messages.length = maxMessages;
  broadcast({ type: "message", message: record });
  return { record, duplicate: false };
}

function updateProcessing(record, patch) {
  record.processing = {
    ...record.processing,
    ...patch,
    extraction: { ...record.processing.extraction, ...(patch.extraction || {}) },
    sheet: { ...record.processing.sheet, ...(patch.sheet || {}) },
  };
  broadcast({ type: "processing", id: record.id, processing: record.processing });
}

async function processTask(record, { skipSheet = false } = {}) {
  updateProcessing(record, {
    extraction: { status: taskExtractor.configured ? "extracting" : "rules", error: "" },
    sheet: { status: skipSheet ? "skipped" : record.processing.sheet.status, error: "" },
  });

  let fields;
  try {
    fields = await taskExtractor.extract(record.parsed.text, record.payload);
  } catch (error) {
    updateProcessing(record, {
      extraction: { status: "failed", error: error.message },
      sheet: { status: "not_attempted" },
    });
    return;
  }

  const createdAt = record.processing?.extraction?.createdAt || record.timestamp || record.receivedAt;
  const updatedAt = record.processing?.extraction?.updatedAt || createdAt;
  const taskStatus = fields.status || record.processing?.extraction?.taskStatus || "IN PROGRESS";
  const sheetTask = {
    task: fields.taskContent,
    pic: fields.pic,
    deadline: fields.deadline,
    priority: fields.priority,
    status: taskStatus,
    createdAt,
    updatedAt,
  };

  updateProcessing(record, {
    extraction: {
      status: "complete",
      source: fields.source,
      task: sheetTask.task,
      pic: fields.pic,
      deadline: fields.deadline,
      taskContent: fields.taskContent,
      priority: fields.priority,
      taskStatus,
      createdAt,
      updatedAt,
    },
  });

  if (skipSheet || !googleSheetsWriteEnabled) {
    updateProcessing(record, { sheet: { status: skipSheet ? "skipped" : "paused" } });
    return;
  }
  if (!googleSheets.isConfigured()) {
    updateProcessing(record, { sheet: { status: "not_configured" } });
    return;
  }
  if (!googleSheets.isAuthorized()) {
    updateProcessing(record, {
      sheet: {
        status: "auth_required",
        error: "Chưa kết nối Google. Mở nút Kết nối Google trên website.",
      },
    });
    return;
  }

  updateProcessing(record, { sheet: { status: "writing", error: "" } });
  try {
    const result = await googleSheets.appendTask(sheetTask);
    updateProcessing(record, {
      sheet: {
        status: "written",
        rowNumber: result.rowNumber,
        updatedRange: result.updatedRange,
      },
      extraction: { taskId: result.taskId },
    });
  } catch (error) {
    updateProcessing(record, { sheet: { status: "failed", error: error.message } });
  }
}

async function retryPendingSheetWrites() {
  for (const record of messages) {
    const extraction = record.processing?.extraction;
    const sheet = record.processing?.sheet;
    if (
      record.parsed?.kind === "message" &&
      extraction?.status === "complete" &&
      ["auth_required", "failed"].includes(sheet?.status)
    ) {
      await processTask(record);
    }
  }
}

function broadcast(data) {
  const packet = `data: ${JSON.stringify(data)}\n\n`;
  for (const response of clients) response.write(packet);
}

function handleStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  response.write(`data: ${JSON.stringify({ type: "snapshot", messages })}\n\n`);
  clients.add(response);
  request.on("close", () => clients.delete(response));
}

function redirect(response, location) {
  response.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
  });
  response.end();
}

function removeExpiredOAuthStates() {
  const now = Date.now();
  for (const [state, expiresAt] of oauthStates) {
    if (expiresAt <= now) oauthStates.delete(state);
  }
}

async function startGoogleAuthorization(response) {
  if (!googleSheets.isConfigured()) {
    redirect(response, "/?google=not-configured");
    return;
  }
  removeExpiredOAuthStates();
  const state = randomBytes(32).toString("hex");
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  redirect(response, googleSheets.getAuthorizationUrl(state));
}

async function handleGoogleCallback(url, response) {
  if (url.searchParams.get("error")) {
    redirect(response, "/?google=cancelled");
    return;
  }

  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const expiresAt = oauthStates.get(state);
  oauthStates.delete(state);
  if (!state || !expiresAt || expiresAt <= Date.now() || !code) {
    sendJson(response, 400, { ok: false, error: "Google OAuth state hoặc code không hợp lệ" });
    return;
  }

  try {
    await googleSheets.authorizeWithCode(code);
    void retryPendingSheetWrites();
    redirect(response, "/?google=connected");
  } catch (error) {
    console.error("Google OAuth callback failed:", error.message);
    redirect(response, "/?google=error");
  }
}

async function handleWebhook(request, response) {
  let rawBody;
  try {
    rawBody = await readRequestBody(request);
  } catch (error) {
    sendJson(response, 413, { ok: false, error: error.message });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendJson(response, 400, { ok: false, error: "Body phải là JSON hợp lệ" });
    return;
  }

  if (payload?.event_type !== "event_verification" && !signaturesMatch(rawBody, getHeader(request, "Signature"))) {
    sendJson(response, 401, { ok: false, error: "Signature không hợp lệ" });
    return;
  }

  if (payload?.event_type === "event_verification") {
    addMessage(payload);
    sendJson(response, 200, payload.event || {});
    return;
  }

  const { record, duplicate } = addMessage(payload);
  if (!duplicate && record.parsed.kind === "message") void processTask(record);
  if (
    duplicate &&
    record.parsed.kind === "message" &&
    record.processing?.sheet?.status === "failed" &&
    googleSheetsWriteEnabled
  ) {
    void processTask(record);
  }
  sendJson(response, 200, { ok: true, received: record.id, deduped: duplicate });
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicDir, requested));

  if (!filePath.startsWith(publicDir + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(response, 404, { ok: false, error: "Không tìm thấy trang" });
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Signature",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && pathname === "/auth/google") {
    await startGoogleAuthorization(response);
    return;
  }

  if (request.method === "GET" && pathname === "/auth/google/callback") {
    await handleGoogleCallback(url, response);
    return;
  }

  if (request.method === "GET" && pathname === "/api/google/status") {
    sendJson(response, 200, {
      ...googleSheets.getStatus(),
      writeEnabled: googleSheetsWriteEnabled,
      redirectUri: googleOAuthRedirectUri,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/google/disconnect") {
    googleSheets.disconnect();
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      messages: messages.length,
      signatureCheck: Boolean(signingSecret),
      chatflowConfigured: Boolean(chatflowUrl && chatflowToken),
      taskExtractor: taskExtractor.provider,
      taskExtractionConfigured: taskExtractor.configured,
      googleSheetsWriteEnabled,
      googleSheetsConfigured: googleSheets.isConfigured(),
      googleSheetsAuthorized: googleSheets.isAuthorized(),
      googleAccountEmail: googleSheets.getStatus().accountEmail,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/messages") {
    sendJson(response, 200, { messages });
    return;
  }

  if (request.method === "DELETE" && pathname === "/api/messages") {
    messages.length = 0;
    broadcast({ type: "clear" });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/stream") {
    handleStream(request, response);
    return;
  }

  if (request.method === "POST" && ["/callback", "/seatalk/callback", "/webhook/seatalk"].includes(pathname)) {
    await handleWebhook(request, response);
    return;
  }

  if (request.method === "POST" && pathname === "/api/test-message") {
    const { record } = addMessage({
      event_id: `demo-${Date.now()}`,
      event_type: "message_from_bot_subscriber",
      timestamp: Math.floor(Date.now() / 1000),
      app_id: "demo-app",
      event: {
        employee_code: "demo.user",
        message: { tag: "text", text: { content: "Đây là một tin nhắn SeaTalk mẫu." } },
      },
    });
    if (record.parsed.kind === "message") void processTask(record, { skipSheet: true });
    sendJson(response, 200, { ok: true, message: record });
    return;
  }

  if (request.method === "GET") {
    await serveStatic(pathname, response);
    return;
  }

  sendJson(response, 405, { ok: false, error: "Method không được hỗ trợ" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Alpha Intel SeaTalk inbox: http://localhost:${port}`);
  console.log(`Webhook callback: http://localhost:${port}/callback`);
  if (signingSecret) console.log("SeaTalk signature verification: enabled");
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
