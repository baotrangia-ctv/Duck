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
    taskContent: "Cần cập nhật dashboard trước 25/09/2026",
    priority: "P2",
    status: "IN PROGRESS",
    source: "rules",
  });
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
