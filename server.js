import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createTaskExtractor, extractPayloadHints } from "./src/task-extractor.js";
import { GoogleSheetsClient } from "./src/google-sheets.js";
import {
  SeaTalkClient,
  buildConfirmationMessage,
  buildConfirmedMessage,
  buildSheetTaskUpdateMessage,
  buildSheetTaskUpdatedMessage,
  buildTaskClarificationMessage,
  buildTaskAssignmentMessage,
  buildTaskAssignmentUpdatedMessage,
  resolveDeadlineQuickPick,
} from "./src/seatalk.js";
import {
  isClarificationClickAuthorized,
  isConfirmationClickAuthorized,
  isSheetUpdateClickAuthorized,
  isTaskMessageUpdateAuthorized,
} from "./src/confirmation-auth.js";
import { parseConfirmationButtonValue } from "./src/confirmation-routing.js";
import { detectTaskIntent } from "./src/sheet-task-updates.js";
import {
  createPendingClarification,
  createTask,
  createThreadSession,
  findTaskByMessageId,
  getRecentTasks,
  reopenTaskForConfirmation,
  resolveTaskRoute,
} from "./src/thread-sessions.js";

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
const host = process.env.HOST || "0.0.0.0";
const signingSecret = process.env.SEATALK_SIGNING_SECRET || "";
const seatalk = new SeaTalkClient({
  appId: process.env.SEATALK_APP_ID || "",
  appSecret: process.env.SEATALK_APP_SECRET || "",
  accessToken: process.env.SEATALK_ACCESS_TOKEN || "",
  baseUrl: process.env.SEATALK_API_BASE_URL || "https://openapi.seatalk.io",
});
const chatflowUrl = process.env.CHATFLOW_API_URL || "";
const chatflowToken = process.env.CHATFLOW_API_TOKEN || "";
const googleSheetsWriteEnabled = String(process.env.GOOGLE_SHEETS_WRITE_ENABLED || "false").toLowerCase() === "true";
const googleOAuthRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${port}/auth/google/callback`;
const googleOAuthTokenPath = resolve(root, process.env.GOOGLE_OAUTH_TOKEN_PATH || ".oauth/google-token.json");
const taskExtractor = createTaskExtractor({
  provider: process.env.TASK_EXTRACTOR || "auto",
  chatflowUrl,
  chatflowToken,
  holidayDates: process.env.HOLIDAY_DATES || "",
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
const threadSessions = new Map();
const confirmationDrafts = new Map();
const sheetUpdateDrafts = new Map();
const sheetMessageReferences = new Map();

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
  const sender = event?.sender || event?.user || event?.from || message?.sender || {};
  const text =
    message?.text?.content ||
    message?.text?.plain_text ||
    message?.plain_text ||
    message?.content ||
    event?.text?.content ||
    event?.text?.plain_text ||
    event?.content ||
    "";

  if (eventType === "interactive_message_click") {
    const clicker = event?.clicker || event?.sender || event?.user || event;
    return {
      kind: "interaction",
      title: `Bấm nút ${event?.button_value || event?.value || "interactive"}`,
      sender: clicker.name || clicker.employee_code || clicker.seatalk_id || "Không rõ người dùng",
      senderId: clicker.seatalk_id || event?.seatalk_id || clicker.employee_code || event?.employee_code || null,
      seatalkId: clicker.seatalk_id || event?.seatalk_id || null,
      employeeCode: clicker.employee_code || event?.employee_code || null,
      email: clicker.email || event?.email || null,
      messageId: event?.message_id || event?.message?.message_id || null,
      buttonValue: event?.button_value || event?.value || event?.button?.value || "",
      eventType,
    };
  }

  if ([
    "message_from_bot_subscriber",
    "new_bot_subscriber_message",
    "new_mentioned_message_received_from_group_chat",
    "new_message_received_from_thread",
    "message",
  ].includes(eventType)) {
    const messageId = event?.message_id || message.message_id || message.id || payload?.event_id || null;
    return {
      kind: "message",
      title: typeof text === "string" && text.trim() ? text.trim() : "Tin nhắn không có nội dung văn bản",
      text: typeof text === "string" ? text.trim() : "",
      sender: sender.name || event.employee_name || event.sender_name || event.employee_code || sender.employee_code || "Không rõ người gửi",
      senderId: sender.seatalk_id || event.seatalk_id || event.sender_id || sender.employee_code || event.employee_code || null,
      seatalkId: sender.seatalk_id || event.seatalk_id || null,
      employeeCode: sender.employee_code || event.employee_code || null,
      email: sender.email || event.email || null,
      messageId,
      quotedMessageId: message.quoted_message_id || message.quotedMessageId || event.quoted_message_id || null,
      groupId: event.group_id || event.group?.group_id || null,
      threadId: event.thread_id || message.thread_id || event.thread?.thread_id || message.thread?.thread_id || (event.group_id || event.group?.group_id ? messageId : null),
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
      status: "awaiting_confirmation",
      rowNumber: null,
      updatedRange: "",
      error: "",
    },
    confirmation: {
      status: "queued",
      draftId: null,
      messageId: null,
      error: "",
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
    confirmation: { ...record.processing.confirmation, ...(patch.confirmation || {}) },
  };
  broadcast({ type: "processing", id: record.id, processing: record.processing });
}

function conversationKey(parsed) {
  if (parsed?.groupId) return `group:${parsed.groupId}:thread:${parsed.threadId || parsed.messageId || "unknown"}`;
  if (parsed?.employeeCode) return `single:${parsed.employeeCode}`;
  if (parsed?.senderId) return `sender:${parsed.senderId}`;
  return null;
}

function threadTarget(parsed, existing = null) {
  return {
    groupId: parsed?.groupId || existing?.groupId || null,
    employeeCode: parsed?.employeeCode || existing?.employeeCode || null,
    threadId: parsed?.threadId || existing?.threadId || null,
  };
}

function normalizeEmail(value) {
  const text = String(value || "").trim().toLowerCase();
  return text && text.includes("@") ? text : null;
}

function resolvePicEmployeeCode(record, draft, task) {
  const payload = record?.payload || {};
  const message = payload?.event?.message || payload?.message || {};
  const sender = message?.sender || payload?.event?.sender || payload?.sender || {};
  const draftPic = normalizeEmail(draft?.pic);
  const senderEmail = normalizeEmail(sender.email || sender.user_email || sender.email_address);
  const senderEmployeeCode = sender.employee_code || sender.employeeCode || null;
  const mentions = Array.isArray(message?.text?.mentioned_list) ? message.text.mentioned_list : [];
  const nonRoutingMentions = mentions.filter((mention) => Number.isInteger(mention?.location) && mention.location > 0);
  const matchingMention = nonRoutingMentions.find((mention) => {
    const mentionEmail = normalizeEmail(mention.email || mention.user_email || mention.email_address);
    return mention.employee_code && (mentionEmail === draftPic || nonRoutingMentions.length === 1);
  });

  if (matchingMention?.employee_code) return matchingMention.employee_code;
  if (task?.picEmployeeCode) return task.picEmployeeCode;
  if (senderEmployeeCode && (!draftPic || senderEmail === draftPic)) return senderEmployeeCode;
  return null;
}

function getThreadSession(record) {
  const key = conversationKey(record.parsed);
  if (!key) return null;
  const existing = threadSessions.get(key);
  if (existing) {
    existing.target = threadTarget(record.parsed, existing.target);
    return existing;
  }
  const session = createThreadSession(key, threadTarget(record.parsed));
  threadSessions.set(key, session);
  return session;
}

function findSessionTaskByMessageId(messageId) {
  for (const session of threadSessions.values()) {
    const task = findTaskByMessageId(session, messageId);
    if (task) return { session, task };
  }
  return null;
}

function rememberSheetMessage(messageId, taskId) {
  const value = String(messageId || "").trim();
  if (!value || taskId === null || taskId === undefined) return;
  sheetMessageReferences.set(value, { taskId: Number(taskId) });
}

function createNewTask(session, record) {
  const createdAt = record.timestamp || record.receivedAt;
  return createTask(session, {
    draftId: `draft-${randomBytes(12).toString("hex")}`,
    recordId: record.id,
    createdAt,
    lastActivityAt: createdAt,
    creatorEmail: record.parsed.email || null,
    creatorEmployeeCode: record.parsed.employeeCode || null,
    creatorSeatalkId: record.parsed.seatalkId || null,
    sourceMessageId: record.parsed.messageId || null,
  });
}

function draftFromFields(fields, task, record) {
  const createdAt = task.createdAt || record.timestamp || record.receivedAt;
  return {
    shortId: task.shortId,
    task: fields.taskContent,
    pic: fields.pic,
    deadline: fields.deadline,
    priority: fields.priority,
    status: fields.status || "IN PROGRESS",
    createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function missingRequiredFields(task) {
  return [
    ["PIC", task.pic],
    ["Deadline", task.deadline],
    ["Task", task.task],
  ].filter(([, value]) => !String(value || "").trim()).map(([field]) => field);
}

async function sendConfirmationCard(record, session, task, draft, { skipSend = false } = {}) {
  if (task.confirmationValue) confirmationDrafts.delete(task.confirmationValue);
  task.confirmationValue = null;
  task.confirmationMessageId = null;

  if (skipSend || !record.parsed.groupId && !record.parsed.employeeCode) {
    updateProcessing(record, {
      sheet: { status: skipSend ? "skipped" : "awaiting_confirmation" },
      confirmation: { status: "not_attempted", draftId: task.draftId, messageId: null },
    });
    return;
  }
  if (!seatalk.isConfigured()) {
    updateProcessing(record, {
      confirmation: {
        status: "not_configured",
        draftId: task.draftId,
        error: "Chưa cấu hình SEATALK_APP_ID/SEATALK_APP_SECRET hoặc SEATALK_ACCESS_TOKEN để gửi card Confirm.",
      },
    });
    return;
  }

  const confirmationValue = `task:confirm:${task.draftId}`;
  task.confirmationValue = confirmationValue;
  confirmationDrafts.set(confirmationValue, {
    threadKey: session.key,
    shortId: task.shortId,
    recordId: record.id,
    draftId: task.draftId,
  });

  updateProcessing(record, { confirmation: { status: "sending", draftId: task.draftId, error: "" } });
  try {
    const message = buildConfirmationMessage(draft, confirmationValue);
    const result = await seatalk.sendReply(session.target, message);
    task.confirmationMessageId = result?.message_id || null;
    updateProcessing(record, {
      confirmation: { status: "sent", draftId: task.draftId, messageId: task.confirmationMessageId, error: "" },
    });
  } catch (error) {
    confirmationDrafts.delete(confirmationValue);
    task.confirmationValue = null;
    updateProcessing(record, {
      confirmation: { status: "failed", draftId: task.draftId, error: error.message },
    });
  }
}

async function redrawConfirmationCard(record, session, task, draft) {
  try {
    if (!task.confirmationMessageId || !task.confirmationValue) {
      throw new Error("Thiếu message_id hoặc callback value của card xác nhận để cập nhật.");
    }
    await seatalk.updateInteractiveMessage(
      task.confirmationMessageId,
      buildConfirmationMessage(draft, task.confirmationValue),
    );
    updateProcessing(record, {
      extraction: {
        deadline: draft.deadline,
        priority: draft.priority,
        updatedAt: draft.updatedAt,
      },
      confirmation: {
        status: "sent",
        draftId: task.draftId,
        messageId: task.confirmationMessageId,
        error: "",
      },
    });
  } catch (error) {
    console.error("SeaTalk confirmation card update failed; resending:", error.message);
    await sendConfirmationCard(record, session, task, draft);
  }
}

function sheetTaskTarget(record) {
  return threadTarget(record.parsed);
}

function isSheetRowUpdateAuthorized(record, task) {
  const requesterEmail = normalizeEmail(record?.parsed?.email);
  const picEmail = normalizeEmail(task?.pic);
  return Boolean(requesterEmail && picEmail && requesterEmail === picEmail);
}

async function sendSheetUpdateText(record, text) {
  if (!seatalk.isConfigured()) return;
  try {
    await seatalk.sendReply(sheetTaskTarget(record), {
      tag: "text",
      text: { format: 2, content: text },
    });
  } catch (error) {
    console.error("SeaTalk Sheet update reply failed:", error.message);
  }
}

function createSheetUpdateDraft(record, sheetTask, { picEmployeeCode = null } = {}) {
  const updateId = `update-${randomBytes(12).toString("hex")}`;
  const pending = {
    updateId,
    rowNumber: sheetTask.rowNumber,
    taskId: sheetTask.id,
    fields: { ...sheetTask },
    target: sheetTaskTarget(record),
    recordId: record.id,
    picEmail: normalizeEmail(sheetTask.pic),
    picEmployeeCode: picEmployeeCode || record.parsed.employeeCode || null,
    messageId: null,
    fieldUpdatePromise: null,
    confirmPromise: null,
  };
  sheetUpdateDrafts.set(updateId, pending);
  return pending;
}

function applyNaturalSheetUpdate(record, pending) {
  const hints = extractPayloadHints(record.parsed.text, record.payload);
  if (hints.deadline) pending.fields.deadline = hints.deadline;

  const priority = /\b(?:priority|uu tien|muc do uu tien|do uu tien)\b/i.test(record.parsed.text || "")
    ? String(record.parsed.text || "").match(/\bP[0-2]\b/i)?.[0]?.toUpperCase()
    : null;
  if (priority) pending.fields.priority = priority;
  return pending;
}

async function sendSheetUpdateCard(record, pending) {
  if (!seatalk.isConfigured()) {
    updateProcessing(record, { confirmation: { status: "not_configured", error: "Chưa cấu hình SeaTalk để gửi form cập nhật task." } });
    return;
  }
  updateProcessing(record, {
    sheet: { status: "awaiting_update_confirmation", rowNumber: pending.rowNumber },
    extraction: {
      taskId: pending.taskId,
      task: pending.fields.task,
      taskContent: pending.fields.task,
      pic: pending.fields.pic,
      deadline: pending.fields.deadline,
      priority: pending.fields.priority,
      taskStatus: pending.fields.status,
    },
    confirmation: { status: "sending", draftId: pending.updateId, error: "" },
  });
  try {
    const result = await seatalk.sendReply(pending.target, buildSheetTaskUpdateMessage(pending.fields, pending.updateId));
    pending.messageId = result?.message_id || null;
    rememberSheetMessage(pending.messageId, pending.taskId);
    updateProcessing(record, { confirmation: { status: "sent", draftId: pending.updateId, messageId: pending.messageId, error: "" } });
  } catch (error) {
    updateProcessing(record, { confirmation: { status: "failed", draftId: pending.updateId, error: error.message } });
  }
}

async function processSheetTaskUpdateById(record, taskId) {
  if (!googleSheetsWriteEnabled) {
    updateProcessing(record, { sheet: { status: "paused", error: "GOOGLE_SHEETS_WRITE_ENABLED đang là false." } });
    await sendSheetUpdateText(record, "Hệ thống đang tắt cập nhật Google Sheet.");
    return;
  }
  if (!googleSheets.isConfigured() || !googleSheets.isAuthorized()) {
    updateProcessing(record, { sheet: { status: "auth_required", error: "Google Sheets OAuth chưa sẵn sàng." } });
    await sendSheetUpdateText(record, "Chưa thể tìm task vì Google Sheets chưa được kết nối.");
    return;
  }

  try {
    const task = await googleSheets.findTaskById(taskId);
    if (!task) {
      updateProcessing(record, { sheet: { status: "not_found", error: "Không tìm thấy task phù hợp trong Google Sheet." } });
      await sendSheetUpdateText(record, `Không tìm thấy Sheet Task ID #${taskId}. Hãy kiểm tra lại ID trong DM của PIC hoặc quote đúng tin nhắn task.`);
      return;
    }
    if (!isSheetRowUpdateAuthorized(record, task)) {
      updateProcessing(record, { sheet: { status: "forbidden", error: "Chỉ PIC của task mới được cập nhật task đã ghi Sheet." } });
      await sendSheetUpdateText(record, "Bạn không có quyền cập nhật task này. Chỉ PIC được ghi trong Sheet mới được đổi Priority/Deadline.");
      return;
    }
    const pending = applyNaturalSheetUpdate(record, createSheetUpdateDraft(record, task));
    await sendSheetUpdateCard(record, pending);
  } catch (error) {
    updateProcessing(record, { sheet: { status: "failed", error: error.message } });
    await sendSheetUpdateText(record, `Tìm task trong Google Sheet thất bại: ${error.message}`);
  }
}

async function processSheetTaskUpdate(record, intent) {
  if (intent.taskId === null) {
    updateProcessing(record, { sheet: { status: "task_id_required", error: "Cần quote task hoặc nêu Sheet Task ID." } });
    await sendSheetUpdateText(
      record,
      "Vui lòng quote đúng tin nhắn task cần update hoặc nêu Sheet Task ID, ví dụ: Đổi deadline Task ID 5 sang thứ 6.",
    );
    return;
  }
  await processSheetTaskUpdateById(record, intent.taskId);
}

async function updateSheetUpdateCard(pending, record) {
  try {
    if (!pending.messageId) throw new Error("Thiếu message_id của card cập nhật task.");
    await seatalk.updateInteractiveMessage(
      pending.messageId,
      buildSheetTaskUpdateMessage(pending.fields, pending.updateId),
    );
    updateProcessing(record, {
      extraction: { deadline: pending.fields.deadline, priority: pending.fields.priority, updatedAt: new Date().toISOString() },
      confirmation: { status: "sent", draftId: pending.updateId, messageId: pending.messageId, error: "" },
    });
  } catch (error) {
    console.error("Sheet update card redraw failed; resending:", error.message);
    await sendSheetUpdateCard(record, pending);
  }
}

async function updateSheetUpdateDraft(value, clickRecord) {
  const action = parseConfirmationButtonValue(value);
  if (!action || (action.kind !== "sheet_update_priority" && action.kind !== "sheet_update_deadline")) {
    return { handled: false, error: "Nút cập nhật Sheet không hợp lệ." };
  }
  const pending = sheetUpdateDrafts.get(action.updateId);
  if (!pending) return { handled: false, error: "Form cập nhật Sheet không còn tồn tại." };
  if (!isSheetUpdateClickAuthorized(clickRecord, pending)) return { handled: true, ignored: true };
  if (pending.fieldUpdatePromise) return pending.fieldUpdatePromise;

  const record = messages.find((item) => item.id === pending.recordId) || clickRecord;
  const nextValue = action.kind === "sheet_update_priority" ? action.value : resolveDeadlineQuickPick(action.value);
  if (!nextValue) return { handled: false, error: "Giá trị cập nhật không hợp lệ." };
  pending.fields[action.kind === "sheet_update_priority" ? "priority" : "deadline"] = nextValue;
  const promise = updateSheetUpdateCard(pending, record);
  pending.fieldUpdatePromise = promise;
  try {
    await promise;
    return { handled: true, updated: true };
  } finally {
    if (pending.fieldUpdatePromise === promise) pending.fieldUpdatePromise = null;
  }
}

async function confirmSheetUpdate(value, clickRecord) {
  const action = parseConfirmationButtonValue(value);
  if (!action || action.kind !== "sheet_update_confirm") return { handled: false, error: "Nút Confirm cập nhật Sheet không hợp lệ." };
  const pending = sheetUpdateDrafts.get(action.updateId);
  if (!pending) return { handled: false, error: "Form cập nhật Sheet không còn tồn tại." };
  if (!isSheetUpdateClickAuthorized(clickRecord, pending)) return { handled: true, ignored: true };
  if (pending.confirmPromise) return pending.confirmPromise;

  const record = messages.find((item) => item.id === pending.recordId) || clickRecord;
  updateProcessing(record, { sheet: { status: "writing", error: "" }, confirmation: { status: "writing", error: "" } });
  const promise = (async () => {
    try {
      pending.fields.updatedAt = new Date().toISOString();
      const result = await googleSheets.updateTask(pending.rowNumber, { ...pending.fields, id: pending.taskId });
      let notificationError = "";
      if (pending.picEmployeeCode) {
        try {
          const notification = await seatalk.sendSingleChat(
            pending.picEmployeeCode,
            buildTaskAssignmentUpdatedMessage({ ...pending.fields, taskId: pending.taskId }),
          );
          rememberSheetMessage(notification?.message_id, pending.taskId);
        } catch (error) {
          notificationError = error.message;
        }
      } else {
        notificationError = "Không xác định được employee_code của PIC để gửi DM cập nhật.";
      }

      let cardError = "";
      try {
        await seatalk.updateInteractiveMessage(
          pending.messageId,
          buildSheetTaskUpdatedMessage(pending.fields, pending.updateId),
        );
      } catch (error) {
        cardError = error.message;
      }
      const errorText = [notificationError, cardError].filter(Boolean).join(" ");
      updateProcessing(record, {
        sheet: { status: "updated", rowNumber: result.rowNumber, updatedRange: result.updatedRange, error: "" },
        extraction: { taskId: result.taskId, deadline: pending.fields.deadline, priority: pending.fields.priority, updatedAt: pending.fields.updatedAt },
        confirmation: { status: "updated", draftId: pending.updateId, messageId: pending.messageId, error: errorText },
      });
      sheetUpdateDrafts.delete(pending.updateId);
      return { handled: true, updated: true };
    } catch (error) {
      updateProcessing(record, { sheet: { status: "failed", error: error.message }, confirmation: { status: "failed", error: error.message } });
      await sendSheetUpdateText(record, `Cập nhật Google Sheet thất bại: ${error.message}`);
      return { handled: true, error: error.message };
    }
  })();
  pending.confirmPromise = promise;
  try {
    return await promise;
  } finally {
    if (pending.confirmPromise === promise) pending.confirmPromise = null;
  }
}

async function sendClarificationCard(record, session, clarification) {
  if (!seatalk.isConfigured()) {
    updateProcessing(record, {
      confirmation: {
        status: "not_configured",
        error: "Chưa cấu hình SeaTalk để gửi card chọn task.",
      },
    });
    return;
  }

  const tasks = getRecentTasks(session);
  const message = buildTaskClarificationMessage(
    record.parsed.text,
    clarification.clarifyId,
    tasks,
    session.tasks.size > tasks.length,
  );
  updateProcessing(record, { confirmation: { status: "clarifying", error: "" } });
  try {
    const result = await seatalk.sendReply(session.target, message);
    clarification.clarifyMessageId = result?.message_id || null;
    updateProcessing(record, {
      confirmation: { status: "clarification_sent", messageId: clarification.clarifyMessageId, error: "" },
    });
  } catch (error) {
    updateProcessing(record, { confirmation: { status: "failed", error: error.message } });
  }
}

function updateTaskFromDraft(task, draft, record) {
  task.fields = {
    taskContent: draft.task,
    pic: draft.pic,
    deadline: draft.deadline,
    priority: draft.priority,
    status: draft.status,
  };
  task.recordId = record.id;
  task.lastActivityAt = record.timestamp || record.receivedAt;
  task.history = [...task.history, record.parsed.text].filter(Boolean).slice(-6);
}

async function processTaskForTask(record, session, task, { skipSheet = false } = {}) {
  const context = task.fields ? { fields: task.fields, history: task.history } : null;
  const wasWritten = task.written;
  updateProcessing(record, {
    extraction: { status: taskExtractor.configured ? "extracting" : "rules", error: "" },
    sheet: { status: skipSheet ? "skipped" : "awaiting_confirmation", error: "" },
    confirmation: { status: "queued", draftId: task.draftId, error: "" },
  });

  let fields;
  try {
    fields = await taskExtractor.extract(record.parsed.text, record.payload, { context });
  } catch (error) {
    updateProcessing(record, {
      extraction: { status: "failed", error: error.message },
      sheet: { status: "not_attempted" },
      confirmation: { status: "not_attempted" },
    });
    return;
  }

  const draft = draftFromFields(fields, task, record);
  updateTaskFromDraft(task, draft, record);
  task.picEmployeeCode = resolvePicEmployeeCode(record, draft, task);

  updateProcessing(record, {
    extraction: {
      status: "complete",
      source: fields.source,
      task: draft.task,
      pic: draft.pic,
      deadline: draft.deadline,
      taskContent: draft.task,
      priority: draft.priority,
      taskStatus: draft.status,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      taskId: task.taskId || null,
    },
  });

  if (wasWritten) {
    reopenTaskForConfirmation(task);
    await sendConfirmationCard(record, session, task, draft, { skipSend: skipSheet });
    return;
  }

  if (task.confirmationMessageId && task.confirmationValue && !skipSheet) {
    await redrawConfirmationCard(record, session, task, draft);
    return;
  }

  await sendConfirmationCard(record, session, task, draft, { skipSend: skipSheet });
}

function detectReferencedTaskIntent(text, taskId) {
  const direct = detectTaskIntent(text);
  if (direct) return direct;
  return detectTaskIntent(`Task ID ${taskId} ${text}`);
}

async function rejectUnsupportedSheetUpdate(record) {
  await sendSheetUpdateText(record, "Phase 2 hiện chỉ hỗ trợ đổi Priority và Deadline. Status/PIC chưa được hỗ trợ.");
  updateProcessing(record, { confirmation: { status: "unsupported_update" } });
}

async function requireReferencedSheetTaskUpdate(record, taskId) {
  const intent = detectReferencedTaskIntent(record.parsed.text, taskId);
  if (intent?.intent === "unsupported_update_existing_sheet_task") {
    await rejectUnsupportedSheetUpdate(record);
    return;
  }
  if (intent?.intent !== "update_existing_sheet_task") {
    await sendSheetUpdateText(record, "Hãy nêu rõ Priority hoặc Deadline cần đổi khi quote task, ví dụ: Đổi deadline sang thứ 4.");
    updateProcessing(record, { sheet: { status: "update_fields_required" } });
    return;
  }
  await processSheetTaskUpdateById(record, taskId);
}

async function processTask(record, { skipSheet = false } = {}) {
  const intent = detectTaskIntent(record.parsed.text);
  if (intent?.intent === "unsupported_update_existing_sheet_task") {
    await rejectUnsupportedSheetUpdate(record);
    return;
  }

  const quotedTaskReference = record.parsed.quotedMessageId
    ? findSessionTaskByMessageId(record.parsed.quotedMessageId)
    : null;
  if (quotedTaskReference) {
    const { session, task } = quotedTaskReference;
    if (task.written) {
      if (!isTaskMessageUpdateAuthorized(record, task)) {
        updateProcessing(record, { confirmation: { status: "ignored", error: "Chỉ PIC của task đã ghi Sheet mới được cập nhật task này." } });
        return;
      }
      await requireReferencedSheetTaskUpdate(record, task.taskId);
      return;
    }
    if (!isTaskMessageUpdateAuthorized(record, task)) {
      updateProcessing(record, { confirmation: { status: "ignored", error: "Người gửi không có quyền cập nhật task này." } });
      return;
    }
    await processTaskForTask(record, session, task, { skipSheet });
    return;
  }

  const quotedSheetReference = record.parsed.quotedMessageId
    ? sheetMessageReferences.get(String(record.parsed.quotedMessageId))
    : null;
  if (quotedSheetReference) {
    await requireReferencedSheetTaskUpdate(record, quotedSheetReference.taskId);
    return;
  }

  if (record.parsed.quotedMessageId && (!intent || intent.taskId === null)) {
    await sendSheetUpdateText(record, "Không nhận diện được tin nhắn task được quote. Hãy quote lại đúng tin nhắn task hoặc nêu Sheet Task ID, ví dụ: Đổi deadline Task ID 5 sang thứ 6.");
    updateProcessing(record, { sheet: { status: "quoted_task_not_found" } });
    return;
  }

  if (intent?.intent === "update_existing_sheet_task") {
    await processSheetTaskUpdate(record, intent);
    return;
  }

  const session = getThreadSession(record);
  if (!session) return;

  const route = resolveTaskRoute(session, record.parsed);
  if (route.kind === "update") {
    if (!isTaskMessageUpdateAuthorized(record, route.task)) {
      updateProcessing(record, { confirmation: { status: "ignored", error: "Người gửi không có quyền cập nhật task này." } });
      return;
    }
    await processTaskForTask(record, session, route.task, { skipSheet });
    return;
  }
  if (route.kind === "clarify") {
    const clarification = createPendingClarification(session, {
      recordId: record.id,
      senderEmail: record.parsed.email || null,
      senderEmployeeCode: record.parsed.employeeCode || null,
      senderSeatalkId: record.parsed.seatalkId || record.parsed.senderId || null,
    });
    await sendClarificationCard(record, session, clarification);
    return;
  }

  const task = route.task || createNewTask(session, record);
  await processTaskForTask(record, session, task, { skipSheet });
}

async function sendConfirmationResult(session, text) {
  if (!session || !seatalk.isConfigured()) return;
  try {
    await seatalk.sendReply(session.target, {
      tag: "text",
      text: { format: 2, content: text },
    });
  } catch (error) {
    console.error("SeaTalk confirmation reply failed:", error.message);
  }
}

async function sendTaskAssignmentNotification(task, draft) {
  if (!task || !seatalk.isConfigured()) return null;
  const employeeCode = task.picEmployeeCode;
  if (!employeeCode) throw new Error("Không xác định được employee_code của PIC để gửi thông báo giao task.");
  return seatalk.sendSingleChat(employeeCode, buildTaskAssignmentMessage(draft));
}

async function updateConfirmationCardAfterConfirm(task, draft) {
  if (!task?.confirmationMessageId || !seatalk.isConfigured()) return "";
  try {
    await seatalk.updateInteractiveMessage(
      task.confirmationMessageId,
      buildConfirmedMessage(draft, task.draftId),
    );
    return "";
  } catch (error) {
    console.error("SeaTalk confirmed card update failed:", error.message);
    return error.message;
  }
}

async function confirmTaskInternal(value, clickRecord, pending, session, task) {
  if (!isConfirmationClickAuthorized(clickRecord, task)) {
    return { handled: true, ignored: true };
  }
  if (task.written && task.rowNumber) return { handled: true, alreadyWritten: true };

  const record = messages.find((item) => item.id === task.recordId) || clickRecord;
  const draft = draftFromFields(task.fields || {}, task, record);
  const missing = missingRequiredFields(draft);
  if (missing.length) {
    updateProcessing(record, {
      sheet: { status: "missing_required_fields", error: `Chưa ghi Google Sheet vì thiếu field bắt buộc: ${missing.join(", ")}.` },
      confirmation: { status: "needs_revision", error: `Thiếu field: ${missing.join(", ")}.` },
    });
    await sendConfirmationResult(session, `Chưa thể ghi Google Sheet. Vui lòng bổ sung: ${missing.join(", ")}.`);
    return { handled: true, missing };
  }
  if (!googleSheetsWriteEnabled) {
    updateProcessing(record, { sheet: { status: "paused", error: "GOOGLE_SHEETS_WRITE_ENABLED đang là false." }, confirmation: { status: "blocked" } });
    await sendConfirmationResult(session, "Đã nhận Confirm nhưng hệ thống đang tắt ghi Google Sheet (GOOGLE_SHEETS_WRITE_ENABLED=false).");
    return { handled: true, blocked: true };
  }
  if (!googleSheets.isConfigured()) {
    updateProcessing(record, { sheet: { status: "not_configured", error: "Google Sheets OAuth chưa được cấu hình." }, confirmation: { status: "blocked" } });
    await sendConfirmationResult(session, "Chưa thể ghi task vì Google Sheets OAuth chưa được cấu hình.");
    return { handled: true, blocked: true };
  }
  if (!googleSheets.isAuthorized()) {
    updateProcessing(record, { sheet: { status: "auth_required", error: "Chưa kết nối Google. Mở nút Kết nối Google trên website." }, confirmation: { status: "blocked" } });
    await sendConfirmationResult(session, "Chưa thể ghi task vì bot chưa được kết nối Google Sheets.");
    return { handled: true, blocked: true };
  }

  updateProcessing(record, { sheet: { status: "writing", error: "" }, confirmation: { status: "writing", error: "" } });
  try {
    const result = task.rowNumber
      ? await googleSheets.updateTask(task.rowNumber, { ...draft, id: task.taskId })
      : await googleSheets.appendTask(draft);
    task.rowNumber = result.rowNumber;
    task.taskId = result.taskId;
    task.written = true;
    confirmationDrafts.delete(value);
    let notificationError = "";
    try {
      const notification = await sendTaskAssignmentNotification(task, { ...draft, taskId: result.taskId });
      task.assignmentMessageId = notification?.message_id || null;
      rememberSheetMessage(task.assignmentMessageId, result.taskId);
    } catch (notificationException) {
      notificationError = notificationException.message;
      console.error("SeaTalk PIC notification failed:", notificationError);
    }
    const confirmationCardError = await updateConfirmationCardAfterConfirm(task, draft);
    const confirmationError = [notificationError, confirmationCardError].filter(Boolean).join(" ");
    const confirmationMessageId = task.confirmationMessageId;
    task.confirmationValue = null;
    updateProcessing(record, {
      sheet: { status: "written", rowNumber: result.rowNumber, updatedRange: result.updatedRange },
      extraction: { taskId: result.taskId, updatedAt: draft.updatedAt },
      confirmation: { status: "confirmed", draftId: task.draftId, messageId: confirmationMessageId, error: confirmationError },
    });
    return { handled: true, written: true };
  } catch (error) {
    updateProcessing(record, { sheet: { status: "failed", error: error.message }, confirmation: { status: "failed", error: error.message } });
    await sendConfirmationResult(session, `Ghi Google Sheet thất bại: ${error.message}`);
    return { handled: true, error: error.message };
  }
}

async function confirmTask(value, clickRecord) {
  const pending = confirmationDrafts.get(value);
  if (!pending) return { handled: false, error: "Draft xác nhận không còn tồn tại hoặc đã được thay thế." };
  const session = threadSessions.get(pending.threadKey);
  const task = session?.tasks.get(pending.shortId);
  if (!session || !task || task.draftId !== pending.draftId) {
    return { handled: false, error: "Draft xác nhận không còn tồn tại hoặc đã được thay thế." };
  }
  if (task.confirmPromise) return task.confirmPromise;
  const promise = confirmTaskInternal(value, clickRecord, pending, session, task);
  task.confirmPromise = promise;
  try {
    return await promise;
  } finally {
    if (task.confirmPromise === promise) task.confirmPromise = null;
  }
}

async function updateDraftFieldAndRedrawInternal(action, clickRecord, pending, session, task) {
  if (!isConfirmationClickAuthorized(clickRecord, task)) {
    return { handled: true, ignored: true };
  }
  if (task.written && task.rowNumber) return { handled: true, alreadyWritten: true };

  const record = messages.find((item) => item.id === task.recordId) || clickRecord;
  const nextValue = action.kind === "priority"
    ? action.value
    : resolveDeadlineQuickPick(action.value);
  if (!nextValue) return { handled: false, error: "Giá trị cập nhật không hợp lệ." };

  task.fields = {
    ...(task.fields || {}),
    [action.kind === "priority" ? "priority" : "deadline"]: nextValue,
  };
  task.lastActivityAt = new Date().toISOString();
  const draft = draftFromFields(task.fields, task, record);
  await redrawConfirmationCard(record, session, task, draft);
  return { handled: true, updated: true };
}

async function updateDraftFieldAndRedraw(value, clickRecord) {
  const action = parseConfirmationButtonValue(value);
  if (!action || (action.kind !== "priority" && action.kind !== "deadline")) {
    return { handled: false, error: "Nút cập nhật draft không hợp lệ." };
  }

  const confirmationValue = `task:confirm:${action.draftId}`;
  const pending = confirmationDrafts.get(confirmationValue);
  if (!pending) return { handled: false, error: "Draft xác nhận không còn tồn tại hoặc đã được thay thế." };
  const session = threadSessions.get(pending.threadKey);
  const task = session?.tasks.get(pending.shortId);
  if (!session || !task || task.draftId !== pending.draftId) {
    return { handled: false, error: "Draft xác nhận không còn tồn tại hoặc đã được thay thế." };
  }
  if (task.fieldUpdatePromise) return task.fieldUpdatePromise;

  const promise = updateDraftFieldAndRedrawInternal(action, clickRecord, pending, session, task);
  task.fieldUpdatePromise = promise;
  try {
    return await promise;
  } finally {
    if (task.fieldUpdatePromise === promise) task.fieldUpdatePromise = null;
  }
}

function findPendingClarification(clarifyId) {
  for (const session of threadSessions.values()) {
    const clarification = session.pendingClarifications.get(clarifyId);
    if (clarification) return { session, clarification };
  }
  return null;
}

async function handleClarificationInternal(action, clickRecord, session, clarification) {
  if (!isClarificationClickAuthorized(clickRecord, clarification)) {
    return { handled: true, ignored: true };
  }

  const record = messages.find((item) => item.id === clarification.recordId);
  if (!record) return { handled: false, error: "Tin nhắn cần chọn task không còn tồn tại." };

  const task = action.kind === "clarify_new"
    ? createNewTask(session, record)
    : session.tasks.get(action.shortId);
  if (!task) return { handled: false, error: "Task được chọn không còn tồn tại trong thread." };

  if (action.kind === "clarify_target" && !isTaskMessageUpdateAuthorized(record, task)) {
    return { handled: true, ignored: true };
  }

  await processTaskForTask(record, session, task);
  return { handled: true, taskShortId: task.shortId };
}

async function handleClarification(value, clickRecord) {
  const action = parseConfirmationButtonValue(value);
  if (!action || (action.kind !== "clarify_new" && action.kind !== "clarify_target")) {
    return { handled: false, error: "Nút chọn task không hợp lệ." };
  }

  const pending = findPendingClarification(action.clarifyId);
  if (!pending) return { handled: false, error: "Lựa chọn task không còn tồn tại hoặc đã được thay thế." };
  const { session, clarification } = pending;
  if (clarification.promise) return clarification.promise;

  const promise = handleClarificationInternal(action, clickRecord, session, clarification);
  clarification.promise = promise;
  try {
    return await promise;
  } finally {
    if (clarification.promise === promise) clarification.promise = null;
    session.pendingClarifications.delete(clarification.clarifyId);
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
    redirect(response, "/?google=connected");
  } catch (error) {
    console.error("Google OAuth callback failed:", error.message);
    redirect(response, "/?google=error");
  }
}

function shouldProcessMessage(record) {
  if (record?.parsed?.kind !== "message") return false;
  if (record.parsed.eventType === "new_message_received_from_thread") {
    return Boolean(record.parsed.quotedMessageId || detectTaskIntent(record.parsed.text));
  }
  return true;
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
  if (!duplicate && shouldProcessMessage(record)) {
    void processTask(record);
  }
  if (!duplicate && record.parsed.kind === "interaction") {
    const action = parseConfirmationButtonValue(record.parsed.buttonValue);
    if (action?.kind === "confirm") void confirmTask(record.parsed.buttonValue, record);
    if (action?.kind === "priority" || action?.kind === "deadline") {
      void updateDraftFieldAndRedraw(record.parsed.buttonValue, record);
    }
    if (action?.kind === "clarify_new" || action?.kind === "clarify_target") {
      void handleClarification(record.parsed.buttonValue, record);
    }
    if (action?.kind === "sheet_update_priority" || action?.kind === "sheet_update_deadline") {
      void updateSheetUpdateDraft(record.parsed.buttonValue, record);
    }
    if (action?.kind === "sheet_update_confirm") {
      void confirmSheetUpdate(record.parsed.buttonValue, record);
    }
  }
  if (
    duplicate &&
    shouldProcessMessage(record) &&
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
      seatalkConfigured: seatalk.isConfigured(),
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

server.listen(port, host, () => {
  console.log(`Alpha Intel SeaTalk inbox: http://localhost:${port}`);
  console.log(`Server bind: ${host}:${port}`);
  console.log(`Webhook callback: http://localhost:${port}/callback`);
  if (signingSecret) console.log("SeaTalk signature verification: enabled");
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
