import test from "node:test";
import assert from "node:assert/strict";
import { createTaskExtractor, extractLabeledFields, extractPayloadHints, normalizeDeadline, parseTaskFields, priorityFromIsoDeadline } from "../src/task-extractor.js";
import { GoogleSheetsClient, buildTaskRow } from "../src/google-sheets.js";

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
  assert.equal(normalizeDeadline("trong tuần sau", "2026-09-19"), "25/09/2026");
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
