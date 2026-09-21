import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createTaskExtractor } from "./src/task-extractor.js";
import { GoogleSheetsClient } from "./src/google-sheets.js";
import {
  SeaTalkClient,
  buildConfirmationMessage,
  buildConfirmedMessage,
  buildTaskAssignmentMessage,
  resolveDeadlineQuickPick,
} from "./src/seatalk.js";
import { isConfirmationClickAuthorized } from "./src/confirmation-auth.js";
import { parseConfirmationButtonValue } from "./src/confirmation-routing.js";

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
const conversations = new Map();
const confirmationDrafts = new Map();

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

function isDraftRevisionRequest(text) {
  const value = String(text || "").normalize("NFC").trim();
  if (!value) return false;
  if (/\b(?:tạo|tao|create|new)\s+(?:task|công việc)\b/i.test(value)) return false;
  const fieldMentioned = /\b(?:priority|p0|p1|p2|ưu tiên|mức độ ưu tiên|độ ưu tiên|deadline|hạn(?: chót| hoàn thành)?|due date|pic|người phụ trách|phụ trách|giao cho|status|trạng thái)\b/i.test(value);
  const revisionLanguage = /\b(?:chỉnh|chinh|đổi|doi|sửa|sua|update|cập nhật|cap nhat|thay|set|change|thành|là|sang|về|to)\b/i.test(value);
  return fieldMentioned && revisionLanguage;
}

function conversationTarget(parsed, existing = null) {
  return {
    groupId: parsed?.groupId || existing?.target?.groupId || null,
    employeeCode: parsed?.employeeCode || existing?.target?.employeeCode || null,
    threadId: parsed?.threadId || existing?.target?.threadId || null,
  };
}

function normalizeEmail(value) {
  const text = String(value || "").trim().toLowerCase();
  return text && text.includes("@") ? text : null;
}

function resolvePicEmployeeCode(record, draft, conversation) {
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
  if (conversation?.picEmployeeCode) return conversation.picEmployeeCode;
  if (senderEmployeeCode && (!draftPic || senderEmail === draftPic)) return senderEmployeeCode;
  return null;
}

function findRelatedConversation(record, key) {
  const parsed = record.parsed;
  if (!parsed?.groupId || !isDraftRevisionRequest(parsed.text)) return null;

  const candidates = [...new Set(conversations.values())]
    .filter((conversation) => conversation.key !== key)
    .filter((conversation) => conversation.fields && !conversation.written)
    .filter((conversation) => conversation.target?.groupId === parsed.groupId)
    .filter((conversation) => !parsed.employeeCode || !conversation.target?.employeeCode || conversation.target.employeeCode === parsed.employeeCode)
    .sort((a, b) => String(b.lastActivityAt || b.createdAt || "").localeCompare(String(a.lastActivityAt || a.createdAt || "")));

  return candidates[0] || null;
}

function createConversation(record) {
  const key = conversationKey(record.parsed);
  if (!key) return null;
  const existing = conversations.get(key);
  if (existing) {
    existing.target = conversationTarget(record.parsed, existing);
    existing.lastActivityAt = record.timestamp || record.receivedAt;
    return existing;
  }
  const related = findRelatedConversation(record, key);
  if (related) {
    conversations.set(key, related);
    related.key = key;
    related.target = conversationTarget(record.parsed, related);
    related.lastActivityAt = record.timestamp || record.receivedAt;
    return related;
  }
  const conversation = {
    key,
    draftId: `draft-${randomBytes(12).toString("hex")}`,
    target: conversationTarget(record.parsed),
    fields: null,
    history: [],
    recordId: record.id,
    createdAt: record.timestamp || record.receivedAt,
    rowNumber: null,
    taskId: null,
    confirmationValue: null,
    confirmationMessageId: null,
    fieldUpdatePromise: null,
    creatorEmail: record.parsed.email || null,
    creatorEmployeeCode: record.parsed.employeeCode || null,
    creatorSeatalkId: record.parsed.seatalkId || null,
    picEmployeeCode: null,
    written: false,
    lastActivityAt: record.timestamp || record.receivedAt,
  };
  conversations.set(key, conversation);
  return conversation;
}

function draftFromFields(fields, conversation, record) {
  const createdAt = conversation.createdAt || record.timestamp || record.receivedAt;
  return {
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

async function sendConfirmationCard(record, conversation, draft, { skipSend = false } = {}) {
  if (conversation.confirmationValue) confirmationDrafts.delete(conversation.confirmationValue);
  conversation.confirmationValue = null;

  if (skipSend || !record.parsed.groupId && !record.parsed.employeeCode) {
    updateProcessing(record, {
      sheet: { status: skipSend ? "skipped" : "awaiting_confirmation" },
      confirmation: { status: "not_attempted", draftId: conversation.draftId, messageId: null },
    });
    return;
  }
  if (!seatalk.isConfigured()) {
    updateProcessing(record, {
      confirmation: {
        status: "not_configured",
        draftId: conversation.draftId,
        error: "Chưa cấu hình SEATALK_APP_ID/SEATALK_APP_SECRET hoặc SEATALK_ACCESS_TOKEN để gửi card Confirm.",
      },
    });
    return;
  }

  const confirmationValue = `task:confirm:${conversation.draftId}`;
  conversation.confirmationValue = confirmationValue;
  confirmationDrafts.set(confirmationValue, {
    key: conversation.key,
    recordId: record.id,
    draftId: conversation.draftId,
  });

  updateProcessing(record, { confirmation: { status: "sending", draftId: conversation.draftId, error: "" } });
  try {
    let result;
    if (conversation.target.groupId) {
      result = await seatalk.sendGroupChat(
        conversation.target.groupId,
        buildConfirmationMessage(draft, confirmationValue),
        conversation.target.threadId,
      );
    } else {
      result = await seatalk.sendConfirmation(conversation.target, draft, confirmationValue);
    }
    conversation.confirmationMessageId = result?.message_id || null;
    updateProcessing(record, {
      confirmation: { status: "sent", draftId: conversation.draftId, messageId: conversation.confirmationMessageId, error: "" },
    });
  } catch (error) {
    updateProcessing(record, {
      confirmation: { status: "failed", draftId: conversation.draftId, error: error.message },
    });
  }
}

async function processTask(record, { skipSheet = false } = {}) {
  const conversation = createConversation(record);
  const context = conversation?.fields
    ? { fields: conversation.fields, history: conversation.history }
    : null;
  if (conversation && context) conversation.written = false;
  updateProcessing(record, {
    extraction: { status: taskExtractor.configured ? "extracting" : "rules", error: "" },
    sheet: { status: skipSheet ? "skipped" : "awaiting_confirmation", error: "" },
    confirmation: { status: "queued", error: "" },
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

  const draft = draftFromFields(fields, conversation || { createdAt: null }, record);
  if (conversation) {
    conversation.fields = {
      taskContent: draft.task,
      pic: draft.pic,
      deadline: draft.deadline,
      priority: draft.priority,
      status: draft.status,
    };
    conversation.picEmployeeCode = resolvePicEmployeeCode(record, draft, conversation);
    conversation.recordId = record.id;
    conversation.target = conversationTarget(record.parsed, conversation);
    conversation.history = [...conversation.history, record.parsed.text].filter(Boolean).slice(-6);
  }

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
      taskId: conversation?.taskId || null,
    },
  });

  await sendConfirmationCard(record, conversation || {
    key: `record:${record.id}`,
    draftId: `draft-${record.id}`,
    target: conversationTarget(record.parsed),
    confirmationValue: null,
  }, draft, { skipSend: skipSheet });
}

async function sendConfirmationResult(conversation, text) {
  if (!conversation || !seatalk.isConfigured()) return;
  try {
    await seatalk.sendReply(conversation.target, {
      tag: "text",
      text: { format: 2, content: text },
    });
  } catch (error) {
    console.error("SeaTalk confirmation reply failed:", error.message);
  }
}

async function sendTaskAssignmentNotification(conversation, draft) {
  if (!conversation || !seatalk.isConfigured()) return null;
  const employeeCode = conversation.picEmployeeCode;
  if (!employeeCode) throw new Error("Không xác định được employee_code của PIC để gửi thông báo giao task.");
  return seatalk.sendSingleChat(employeeCode, buildTaskAssignmentMessage(draft));
}

async function updateConfirmationCardAfterConfirm(conversation, draft) {
  if (!conversation?.confirmationMessageId || !seatalk.isConfigured()) return "";
  try {
    await seatalk.updateInteractiveMessage(
      conversation.confirmationMessageId,
      buildConfirmedMessage(draft, conversation.draftId),
    );
    return "";
  } catch (error) {
    console.error("SeaTalk confirmed card update failed:", error.message);
    return error.message;
  }
}

async function confirmTaskInternal(value, clickRecord, pending, conversation) {
  if (!isConfirmationClickAuthorized(clickRecord, conversation)) {
    return { handled: true, ignored: true };
  }
  if (conversation.written && conversation.rowNumber) return { handled: true, alreadyWritten: true };

  const record = messages.find((item) => item.id === conversation.recordId) || clickRecord;
  const draft = draftFromFields(conversation.fields || {}, conversation, record);
  const missing = missingRequiredFields(draft);
  if (missing.length) {
    updateProcessing(record, {
      sheet: { status: "missing_required_fields", error: `Chưa ghi Google Sheet vì thiếu field bắt buộc: ${missing.join(", ")}.` },
      confirmation: { status: "needs_revision", error: `Thiếu field: ${missing.join(", ")}.` },
    });
    await sendConfirmationResult(conversation, `Chưa thể ghi Google Sheet. Vui lòng bổ sung: ${missing.join(", ")}.`);
    return { handled: true, missing };
  }
  if (!googleSheetsWriteEnabled) {
    updateProcessing(record, { sheet: { status: "paused", error: "GOOGLE_SHEETS_WRITE_ENABLED đang là false." }, confirmation: { status: "blocked" } });
    await sendConfirmationResult(conversation, "Đã nhận Confirm nhưng hệ thống đang tắt ghi Google Sheet (GOOGLE_SHEETS_WRITE_ENABLED=false).");
    return { handled: true, blocked: true };
  }
  if (!googleSheets.isConfigured()) {
    updateProcessing(record, { sheet: { status: "not_configured", error: "Google Sheets OAuth chưa được cấu hình." }, confirmation: { status: "blocked" } });
    await sendConfirmationResult(conversation, "Chưa thể ghi task vì Google Sheets OAuth chưa được cấu hình.");
    return { handled: true, blocked: true };
  }
  if (!googleSheets.isAuthorized()) {
    updateProcessing(record, { sheet: { status: "auth_required", error: "Chưa kết nối Google. Mở nút Kết nối Google trên website." }, confirmation: { status: "blocked" } });
    await sendConfirmationResult(conversation, "Chưa thể ghi task vì bot chưa được kết nối Google Sheets.");
    return { handled: true, blocked: true };
  }

  updateProcessing(record, { sheet: { status: "writing", error: "" }, confirmation: { status: "writing", error: "" } });
  try {
    const isUpdate = Boolean(conversation.rowNumber);
    const result = conversation.rowNumber
      ? await googleSheets.updateTask(conversation.rowNumber, { ...draft, id: conversation.taskId })
      : await googleSheets.appendTask(draft);
    conversation.rowNumber = result.rowNumber;
    conversation.taskId = result.taskId;
    conversation.written = true;
    confirmationDrafts.delete(value);
    let notificationError = "";
    try {
      await sendTaskAssignmentNotification(conversation, draft);
    } catch (notificationException) {
      notificationError = notificationException.message;
      console.error("SeaTalk PIC notification failed:", notificationError);
    }
    const confirmationCardError = await updateConfirmationCardAfterConfirm(conversation, draft);
    const confirmationError = [notificationError, confirmationCardError].filter(Boolean).join(" ");
    updateProcessing(record, {
      sheet: { status: "written", rowNumber: result.rowNumber, updatedRange: result.updatedRange },
      extraction: { taskId: result.taskId, updatedAt: draft.updatedAt },
      confirmation: { status: "confirmed", draftId: conversation.draftId, messageId: conversation.confirmationMessageId, error: confirmationError },
    });
    return { handled: true, written: true };
  } catch (error) {
    updateProcessing(record, { sheet: { status: "failed", error: error.message }, confirmation: { status: "failed", error: error.message } });
    await sendConfirmationResult(conversation, `Ghi Google Sheet thất bại: ${error.message}`);
    return { handled: true, error: error.message };
  }
}

async function confirmTask(value, clickRecord) {
  const pending = confirmationDrafts.get(value);
  if (!pending) return { handled: false, error: "Draft xác nhận không còn tồn tại hoặc đã được thay thế." };
  const conversation = conversations.get(pending.key);
  if (!conversation || conversation.draftId !== pending.draftId) {
    return { handled: false, error: "Draft xác nhận không còn tồn tại hoặc đã được thay thế." };
  }
  if (conversation.confirmPromise) return conversation.confirmPromise;
  const promise = confirmTaskInternal(value, clickRecord, pending, conversation);
  conversation.confirmPromise = promise;
  try {
    return await promise;
  } finally {
    if (conversation.confirmPromise === promise) conversation.confirmPromise = null;
  }
}

async function updateDraftFieldAndRedrawInternal(action, clickRecord, pending, conversation) {
  if (!isConfirmationClickAuthorized(clickRecord, conversation)) {
    return { handled: true, ignored: true };
  }
  if (conversation.written && conversation.rowNumber) return { handled: true, alreadyWritten: true };

  const record = messages.find((item) => item.id === conversation.recordId) || clickRecord;
  const nextValue = action.kind === "priority"
    ? action.value
    : resolveDeadlineQuickPick(action.value);
  if (!nextValue) return { handled: false, error: "Giá trị cập nhật không hợp lệ." };

  conversation.fields = {
    ...(conversation.fields || {}),
    [action.kind === "priority" ? "priority" : "deadline"]: nextValue,
  };
  conversation.lastActivityAt = new Date().toISOString();
  const draft = draftFromFields(conversation.fields, conversation, record);
  const message = buildConfirmationMessage(draft, conversation.confirmationValue);

  try {
    if (!conversation.confirmationMessageId) throw new Error("Thiếu message_id của card xác nhận để cập nhật.");
    await seatalk.updateInteractiveMessage(conversation.confirmationMessageId, message);
    updateProcessing(record, {
      extraction: {
        deadline: draft.deadline,
        priority: draft.priority,
        updatedAt: draft.updatedAt,
      },
      confirmation: {
        status: "sent",
        draftId: conversation.draftId,
        messageId: conversation.confirmationMessageId,
        error: "",
      },
    });
    return { handled: true, updated: true };
  } catch (error) {
    console.error("SeaTalk confirmation card update failed; resending:", error.message);
    await sendConfirmationCard(record, conversation, draft);
    return { handled: true, updated: false, resent: true, error: error.message };
  }
}

async function updateDraftFieldAndRedraw(value, clickRecord) {
  const action = parseConfirmationButtonValue(value);
  if (!action || (action.kind !== "priority" && action.kind !== "deadline")) {
    return { handled: false, error: "Nút cập nhật draft không hợp lệ." };
  }

  const confirmationValue = `task:confirm:${action.draftId}`;
  const pending = confirmationDrafts.get(confirmationValue);
  if (!pending) return { handled: false, error: "Draft xác nhận không còn tồn tại hoặc đã được thay thế." };
  const conversation = conversations.get(pending.key);
  if (!conversation || conversation.draftId !== pending.draftId) {
    return { handled: false, error: "Draft xác nhận không còn tồn tại hoặc đã được thay thế." };
  }
  if (conversation.fieldUpdatePromise) return conversation.fieldUpdatePromise;

  const promise = updateDraftFieldAndRedrawInternal(action, clickRecord, pending, conversation);
  conversation.fieldUpdatePromise = promise;
  try {
    return await promise;
  } finally {
    if (conversation.fieldUpdatePromise === promise) conversation.fieldUpdatePromise = null;
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
  if (!duplicate && record.parsed.kind === "message") {
    void processTask(record);
  }
  if (!duplicate && record.parsed.kind === "interaction") {
    const action = parseConfirmationButtonValue(record.parsed.buttonValue);
    if (action?.kind === "confirm") void confirmTask(record.parsed.buttonValue, record);
    if (action?.kind === "priority" || action?.kind === "deadline") {
      void updateDraftFieldAndRedraw(record.parsed.buttonValue, record);
    }
  }
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
