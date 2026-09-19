import test from "node:test";
import assert from "node:assert/strict";
import { createTaskExtractor, deadlineFromPriority, extractLabeledFields, extractPayloadHints, normalizeDeadline, parseTaskFields, priorityFromIsoDeadline } from "../src/task-extractor.js";
import { GoogleSheetsClient, buildTaskRow } from "../src/google-sheets.js";
import { SeaTalkClient, buildConfirmationMessage, buildTaskAssignmentMessage } from "../src/seatalk.js";

test("parseTaskFields reads and normalizes the required JSON fields", () => {
  const result = parseTaskFields('{"pic":"an@example.com","deadline":"30/09","task":"Cập nhật dashboard","status":"DONE"}', "2026-09-19");
  assert.deepEqual(result, {
    pic: "an@example.com",
    deadline: "30/09/2026",
    taskContent: "Cập nhật dashboard",
    priority: null,
    status: "DONE",
  });
});

test("parseTaskFields accepts markdown fences and Vietnamese field names", () => {
  const result = parseTaskFields('```json\n{"PIC":"linh@example.com","deadline":null,"nội dung công việc":"Kiểm tra báo cáo"}\n```');
  assert.deepEqual(result, {
    pic: "linh@example.com",
    deadline: null,
    taskContent: "Kiểm tra báo cáo",
    priority: null,
    status: null,
  });
});

test("extractLabeledFields handles rule-based fallback", () => {
  const result = extractLabeledFields("PIC: an@example.com; deadline: 30/09; nội dung công việc: cập nhật dashboard", "2026-09-19");
  assert.deepEqual(result, {
    pic: "an@example.com",
    deadline: "30/09/2026",
    taskContent: "cập nhật dashboard",
    priority: null,
    status: null,
  });
});

test("rules provider keeps the message as task content without inventing fields", async () => {
  const extractor = createTaskExtractor({ provider: "rules" });
  const result = await extractor.extract("Cần cập nhật dashboard trước 25/09/2026", { event_type: "message" });
  assert.deepEqual(result, {
    pic: null,
    deadline: "25/09/2026",
    taskContent: "cập nhật dashboard",
    priority: "P2",
    status: "IN PROGRESS",
    source: "rules",
  });
});

test("priority defaults to P2 when no deadline is available", async () => {
  const extractor = createTaskExtractor({ provider: "rules" });
  const result = await extractor.extract("Cập nhật tài liệu hướng dẫn", { event_type: "message" });
  assert.equal(result.priority, "P2");
  assert.match(result.deadline, /^\d{2}\/\d{2}\/\d{4}$/);
});

test("priority follows the policy for ISO deadlines", () => {
  assert.equal(priorityFromIsoDeadline("2026-09-18", "2026-09-18"), "P0");
  assert.equal(priorityFromIsoDeadline("2026-09-20", "2026-09-18"), "P1");
  assert.equal(priorityFromIsoDeadline("2026-09-25", "2026-09-18"), "P2");
  assert.equal(priorityFromIsoDeadline("18/09", "2026-09-18"), null);
});

test("payload hints extract the assigned email and normalize a natural Vietnamese deadline", () => {
  const text = "@Duck_Test giao cho @Chung Anh (Lemon) 🍋 lấy snack trước 4h chiều nay";
  const payload = {
    event: {
      message: {
        text: {
          plain_text: text,
          mentioned_list: [
            { username: "Duck_Test", location: 0, length: 10 },
            { username: "Chung Anh (Lemon) 🍋", email: "chung@example.com", employee_code: "517814", location: 20, length: 21 },
          ],
        },
      },
    },
  };
  assert.deepEqual(extractPayloadHints(text, payload, "2026-09-19"), {
    pic: "chung@example.com",
    deadline: "19/09/2026",
    taskContent: "lấy snack",
    status: null,
  });
});

test("deadline normalization resolves the nearest future date from partial dates", () => {
  assert.equal(normalizeDeadline("18/9", "2026-09-19"), "18/09/2027");
  assert.equal(normalizeDeadline("ngày 18", "2026-09-19"), "18/10/2026");
  assert.equal(normalizeDeadline("thứ 2 tuần sau", "2026-09-19"), "21/09/2026");
  assert.equal(normalizeDeadline("tuần sau", "2026-09-19"), "25/09/2026");
  assert.equal(normalizeDeadline("trong tuần sau", "2026-09-19"), "25/09/2026");
  assert.equal(normalizeDeadline("tuần sau", "2026-09-19", "25/09/2026"), "24/09/2026");
  assert.equal(normalizeDeadline("trong tuần này", "2026-09-19", "18/09/2026"), "17/09/2026");
});

test("priority maps to a deadline when no explicit date is available", () => {
  assert.equal(deadlineFromPriority("P0", "2026-09-19"), "19/09/2026");
  assert.equal(deadlineFromPriority("P1", "2026-09-19"), "22/09/2026");
  assert.equal(deadlineFromPriority("P2", "2026-09-19"), "26/09/2026");
  assert.equal(extractLabeledFields("priority: P1; nội dung công việc: cập nhật dashboard", "2026-09-19").deadline, "22/09/2026");
});

test("rules provider infers urgent priority and today's deadline", async () => {
  const extractor = createTaskExtractor({ provider: "rules" });
  const result = await extractor.extract("Làm gấp giúp anh tối ưu client", { event_type: "message" });
  assert.equal(result.priority, "P0");
  const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  assert.equal(result.deadline, today);
});

test("payload hints read a date introduced by a completion phrase", () => {
  const text = "mình sẽ hoàn thành báo cáo vào ngày 18/9";
  const payload = { event: { sender: { email: "sender@example.com" }, message: { text: { plain_text: text, mentioned_list: [] } } } };
  assert.equal(extractPayloadHints(text, payload, "2026-09-19").deadline, "18/09/2027");
});

test("payload hints assign self-owned tasks to the sender email", () => {
  const text = "@Duck_Test mình sẽ cập nhật dashboard trước ngày 18";
  const payload = {
    event: {
      sender: { email: "sender@example.com" },
      message: {
        text: {
          plain_text: text,
          mentioned_list: [{ username: "Duck_Test", location: 0, length: 10 }],
        },
      },
    },
  };
  assert.equal(extractPayloadHints(text, payload, "2026-09-19").pic, "sender@example.com");
  assert.equal(extractPayloadHints(text, payload, "2026-09-19").deadline, "18/10/2026");
});

test("payload hints recognize an explicit self-assignment", () => {
  const text = "giao cho tôi kiểm tra báo cáo trước ngày 18";
  const payload = { event: { sender: { email: "sender@example.com" }, message: { text: { plain_text: text, mentioned_list: [] } } } };
  assert.equal(extractPayloadHints(text, payload, "2026-09-19").pic, "sender@example.com");
});

test("payload hints support the actual SeaTalk event.email and text.content shape", () => {
  const text = "Hãy log task cho tôi trước thứ 2 tuần sau phải optimize xong client performance của SAP";
  const payload = {
    event: {
      employee_code: "517816",
      email: "giabao.tran@garena.vn",
      message: { text: { content: text } },
    },
  };
  assert.deepEqual(extractPayloadHints(text, payload, "2026-09-19"), {
    pic: "giabao.tran@garena.vn",
    deadline: "21/09/2026",
    taskContent: "optimize xong client performance của SAP",
    status: null,
  });
});

test("payload hints choose the mentioned assignee from the actual group-chat shape", () => {
  const text = "@Duck_Test Hãy log task cho @Chung Anh (Lemon) 🍋 trước thứ 2 tuần sau phải optimize xong client performance của Dig";
  const payload = {
    event: {
      message: {
        sender: { email: "giabao.tran@garena.vn" },
        text: {
          plain_text: text,
          mentioned_list: [
            { username: "Duck_Test", email: "", location: 0, length: 10 },
            { username: "Chung Anh (Lemon) 🍋", email: "chunganh.nguyenthi_ctv@garena.vn", location: 29, length: 21 },
          ],
        },
      },
    },
  };
  assert.deepEqual(extractPayloadHints(text, payload, "2026-09-19"), {
    pic: "chunganh.nguyenthi_ctv@garena.vn",
    deadline: "21/09/2026",
    taskContent: "Hãy log task cho phải optimize xong client performance của Dig",
    status: null,
  });
});

test("task row follows the Google Sheet A-H contract", () => {
  assert.deepEqual(buildTaskRow({
    id: 7,
    task: "Cập nhật dashboard",
    pic: "an@example.com",
    deadline: "30/09/2026",
    priority: "P1",
    status: "IN PROGRESS",
    createdAt: "2026-09-19T08:00:00.000Z",
    updatedAt: "2026-09-19T08:00:00.000Z",
  }), [[
    7,
    "Cập nhật dashboard",
    "an@example.com",
    "30/09/2026",
    "P1",
    "IN PROGRESS",
    "2026-09-19T08:00:00.000Z",
    "2026-09-19T08:00:00.000Z",
  ]]);
});

test("Google Sheets client accepts a spreadsheet URL as the ID", () => {
  const client = new GoogleSheetsClient({
    spreadsheetId: "https://docs.google.com/spreadsheets/d/abc123_XYZ/edit#gid=0",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    oauthRedirectUri: "http://localhost:3030/auth/google/callback",
    tokenPath: "test/.oauth-not-used.json",
  });
  assert.equal(client.spreadsheetId, "abc123_XYZ");
  assert.equal(client.isConfigured(), true);
});

test("Google Sheets client builds an OAuth authorization URL", () => {
  const client = new GoogleSheetsClient({
    spreadsheetId: "sheet-id",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    oauthRedirectUri: "http://localhost:3030/auth/google/callback",
    tokenPath: "test/.oauth-not-used.json",
  });
  const url = new URL(client.getAuthorizationUrl("csrf-state"));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:3030/auth/google/callback");
  assert.equal(url.searchParams.get("state"), "csrf-state");
  assert.equal(url.searchParams.get("access_type"), "offline");
});

test("rules extractor preserves draft context when a user only changes the deadline", async () => {
  const extractor = createTaskExtractor({ provider: "rules" });
  const result = await extractor.extract("đổi deadline sang 30/09/2026", {
    event: { email: "an@example.com", message: { text: { content: "đổi deadline sang 30/09/2026" } } },
  }, {
    context: {
      fields: {
        pic: "an@example.com",
        taskContent: "Cập nhật dashboard",
        deadline: "25/09/2026",
        priority: "P2",
        status: "IN PROGRESS",
      },
      history: ["giao cho tôi cập nhật dashboard trước 25/09/2026"],
    },
  });
  assert.deepEqual(result, {
    pic: "an@example.com",
    deadline: "30/09/2026",
    taskContent: "Cập nhật dashboard",
    priority: "P2",
    status: "IN PROGRESS",
    source: "rules",
  });
});

test("rules extractor changes only priority when a user only changes priority", async () => {
  const extractor = createTaskExtractor({ provider: "rules" });
  const result = await extractor.extract("Priority phải là P1", {
    event: { email: "an@example.com", message: { text: { content: "Priority phải là P1" } } },
  }, {
    context: {
      fields: {
        pic: "an@example.com",
        taskContent: "Cập nhật dashboard",
        deadline: "25/09/2026",
        priority: "P2",
        status: "IN PROGRESS",
      },
      history: ["giao cho tôi cập nhật dashboard trước 25/09/2026"],
    },
  });
  assert.deepEqual(result, {
    pic: "an@example.com",
    deadline: "25/09/2026",
    taskContent: "Cập nhật dashboard",
    priority: "P1",
    status: "IN PROGRESS",
    source: "rules",
  });
});

test("rules extractor accepts deadline là Thứ 2 without resetting other fields", async () => {
  const extractor = createTaskExtractor({ provider: "rules", referenceDate: "2026-09-19" });
  const result = await extractor.extract("deadline là Thứ 2", {
    event: { email: "an@example.com", message: { text: { content: "deadline là Thứ 2" } } },
  }, {
    context: {
      fields: {
        pic: "an@example.com",
        taskContent: "Cập nhật dashboard",
        deadline: "25/09/2026",
        priority: "P1",
        status: "IN PROGRESS",
      },
      history: ["priority P1 cho task cập nhật dashboard"],
    },
  });
  assert.deepEqual(result, {
    pic: "an@example.com",
    deadline: "21/09/2026",
    taskContent: "Cập nhật dashboard",
    priority: "P1",
    status: "IN PROGRESS",
    source: "rules",
  });
});

test("SeaTalk client sends a confirmation card to a single-chat recipient", async () => {
  const requests = [];
  const client = new SeaTalkClient({
    accessToken: "access-token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ code: 0, message_id: "card-1" }) };
    },
  });
  await client.sendConfirmation({ employeeCode: "517816" }, {
    task: "Cập nhật dashboard",
    pic: "an@example.com",
    deadline: "30/09/2026",
    priority: "P1",
  }, "task:confirm:draft-1");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://openapi.seatalk.io/messaging/v2/single_chat");
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.employee_code, "517816");
  assert.equal(body.message.tag, "interactive_message");
  assert.equal(body.message.interactive_message.elements[2].button.value, "task:confirm:draft-1");
  assert.match(body.message.interactive_message.elements[1].description.text, /PIC: an@example.com/);
  assert.match(body.message.interactive_message.elements[1].description.text, /Deadline: 30\/09\/2026/);
  assert.equal(buildConfirmationMessage({ task: "x" }, "v").tag, "interactive_message");
});

test("SeaTalk builds a direct PIC assignment notification", () => {
  const message = buildTaskAssignmentMessage({
    task: "Cập nhật dashboard",
    pic: "an@example.com",
    deadline: "30/09/2026",
    priority: "P1",
    status: "IN PROGRESS",
  });

  assert.equal(message.tag, "text");
  assert.match(message.text.content, /Task đã được xác nhận và ghi nhận/);
  assert.match(message.text.content, /PIC: an@example.com/);
  assert.match(message.text.content, /Nội dung Task: Cập nhật dashboard/);
  assert.match(message.text.content, /Deadline: 30\/09\/2026/);
  assert.match(message.text.content, /Priority: P1/);
  assert.match(message.text.content, /Status: IN PROGRESS/);
});
