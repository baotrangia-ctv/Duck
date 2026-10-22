import test from "node:test";
import assert from "node:assert/strict";
import { GoogleSheetsClient } from "../src/google-sheets.js";
import {
  detectTaskIntent,
  extractRequestedStatus,
  findMatchingSheetTasks,
  isStatusOnlyUpdate,
  resolveSheetUpdatePicEmployeeCode,
  sheetRowToTask,
} from "../src/sheet-task-updates.js";
import {
  buildSheetTaskUpdateMessage,
  buildSheetTaskUpdatedMessage,
} from "../src/seatalk.js";
import { parseConfirmationButtonValue } from "../src/confirmation-routing.js";
import {
  isSheetRowUpdateAuthorized,
  isSheetUpdateClickAuthorized,
  isTaskMessageUpdateAuthorized,
} from "../src/confirmation-auth.js";

test("Phase 2 intent extracts Sheet ID and supports Priority/Deadline/Status", () => {
  assert.deepEqual(detectTaskIntent("Đổi priority task 5 thành P0"), {
    intent: "update_existing_sheet_task",
    taskId: 5,
    query: null,
    fields: { priority: true, deadline: false, status: false },
  });
  assert.equal(detectTaskIntent("Đổi deadline #5 sang thứ 4").taskId, 5);
  assert.deepEqual(detectTaskIntent("Task Update UI/UX SAP đổi deadline sang thứ 6"), {
    intent: "update_existing_sheet_task",
    taskId: null,
    query: "ui ux sap",
    fields: { priority: false, deadline: true, status: false },
  });
  assert.deepEqual(detectTaskIntent("Đổi status task 5 thành DONE"), {
    intent: "update_existing_sheet_task",
    taskId: 5,
    query: null,
    fields: { priority: false, deadline: false, status: true },
  });
  assert.deepEqual(detectTaskIntent("Cập nhật task #18 done"), {
    intent: "update_existing_sheet_task",
    taskId: 18,
    query: null,
    fields: { priority: false, deadline: false, status: true },
  });
  assert.equal(extractRequestedStatus("Đổi status task #5 sang DONE"), "DONE");
  assert.equal(extractRequestedStatus("Đổi trạng thái task #5 sang đang làm"), "IN PROGRESS");
  assert.equal(extractRequestedStatus("Đổi status task #5 sang TODO"), "TODO");
  assert.equal(extractRequestedStatus("Đổi status task #5 sang TO DO"), "TODO");
  assert.equal(detectTaskIntent("Đổi status task #5 sang TODO").fields.status, true);
  assert.equal(isStatusOnlyUpdate(detectTaskIntent("Cập nhật task #18 done")), true);
  assert.equal(detectTaskIntent("Cập nhật dashboard trước deadline"), null);
});

test("Sheet task row parsing and content matching return row numbers", () => {
  const rows = [
    [5, "Update UI/UX SAP", "pic@example.com", "25/09/2026", "P2", "IN PROGRESS", "created", "updated", "creator@example.com"],
    [6, "Update UI/UX Web", "other@example.com", "26/09/2026", "P1", "IN PROGRESS", "created", "updated", "other-creator@example.com"],
  ];
  assert.deepEqual(sheetRowToTask(rows[0], 2), {
    id: 5,
    rowNumber: 2,
    task: "Update UI/UX SAP",
    pic: "pic@example.com",
    deadline: "25/09/2026",
    priority: "P2",
    status: "IN PROGRESS",
    createdAt: "created",
    updatedAt: "updated",
    creator: "creator@example.com",
  });
  assert.equal(sheetRowToTask(rows[1].slice(0, 8), 3).creator, "");
  assert.equal(sheetRowToTask([7, "Task", "pic@example.com", "", "P2", "", "created", "updated"], 4).status, "TODO");
  assert.deepEqual(findMatchingSheetTasks(rows, "sap").map((task) => task.id), [5]);
  assert.deepEqual(findMatchingSheetTasks(rows, "update ui ux").map((task) => task.id), [5, 6]);
});

test("Google Sheets client finds a task by ID and by content", async () => {
  const client = new GoogleSheetsClient({
    spreadsheetId: "sheet-id",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    oauthRedirectUri: "http://localhost:3030/auth/google/callback",
    tokenPath: "test/.oauth-not-used.json",
  });
  client.tokens = { access_token: "access-token", expiresAt: Date.now() + 120_000 };
  const readRanges = [];
  client.readValues = async (range) => {
    readRanges.push(range);
    return [
      [5, "Update UI/UX SAP", "pic@example.com", "25/09/2026", "P2", "IN PROGRESS", "created", "updated", "creator@example.com"],
      [6, "Update UI/UX Web", "other@example.com", "26/09/2026", "P1", "IN PROGRESS", "created", "updated", "other-creator@example.com"],
    ];
  };

  assert.equal((await client.findTaskById(5)).rowNumber, 2);
  assert.equal(await client.findTaskById(99), null);
  assert.deepEqual((await client.findTasksByText("ui ux")).map((task) => task.id), [5, 6]);
  assert.deepEqual(readRanges, ["Sheet1!A2:I", "Sheet1!A2:I", "Sheet1!A2:I"]);
});

test("Sheet update routes, cards, and permission support PIC and Creator", () => {
  const update = buildSheetTaskUpdateMessage({
    id: 5,
    task: "Update UI/UX SAP",
    pic: "pic@example.com",
    deadline: "25/09/2026",
    priority: "P2",
    status: "IN PROGRESS",
  }, "update-1");
  const updated = buildSheetTaskUpdatedMessage({
    id: 5,
    task: "Update UI/UX SAP",
    pic: "pic@example.com",
    deadline: "26/09/2026",
    priority: "P1",
    status: "DONE",
  }, "update-1");
  assert.deepEqual(parseConfirmationButtonValue("task:sheet-update:deadline:update-1:tomorrow"), {
    kind: "sheet_update_deadline",
    updateId: "update-1",
    value: "tomorrow",
  });
  assert.deepEqual(parseConfirmationButtonValue("task:sheet-update:confirm:update-1"), {
    kind: "sheet_update_confirm",
    updateId: "update-1",
  });
  assert.equal(update.interactive_message.elements[4].button.text, "Xác nhận đổi");
  assert.match(update.interactive_message.elements[1].description.text, /\*\*Status:\*\* IN PROGRESS/);
  assert.equal(updated.interactive_message.elements[2].button.text, "✅ Đã cập nhật task");
  const pending = { picEmail: "pic@example.com", creatorEmail: "creator@example.com" };
  assert.equal(isSheetUpdateClickAuthorized({ parsed: { email: "pic@example.com" } }, pending), true);
  assert.equal(isSheetUpdateClickAuthorized({ parsed: { email: "creator@example.com" } }, pending), true);
  assert.equal(isSheetUpdateClickAuthorized({ parsed: { email: "other@example.com" } }, pending), false);
  assert.equal(isSheetUpdateClickAuthorized({ parsed: {} }, pending), false);
  assert.equal(isSheetUpdateClickAuthorized({ parsed: { email: "creator@example.com" } }, { picEmail: "pic@example.com", creatorEmail: "" }), false);
});

test("written task edits allow only PIC and the persisted Creator", () => {
  const task = { written: true, fields: { pic: "pic@example.com", creator: "creator@example.com" } };
  assert.equal(isTaskMessageUpdateAuthorized({ parsed: { email: "pic@example.com" } }, task), true);
  assert.equal(isTaskMessageUpdateAuthorized({ parsed: { email: "creator@example.com" } }, task), true);
  assert.equal(isTaskMessageUpdateAuthorized({ parsed: { email: "other@example.com" } }, task), false);
  assert.equal(isTaskMessageUpdateAuthorized({ parsed: {} }, task), false);
  assert.equal(isTaskMessageUpdateAuthorized({ parsed: { email: "creator@example.com" } }, {
    written: true,
    fields: { pic: "pic@example.com", creator: "" },
  }), false);
  assert.equal(isTaskMessageUpdateAuthorized({ parsed: { email: "creator@example.com" } }, {
    written: true,
    fields: { pic: "pic@example.com" },
    creatorEmail: "creator@example.com",
  }), true);
  assert.equal(isTaskMessageUpdateAuthorized({ parsed: { email: "creator@example.com" } }, {
    written: true,
    fields: { pic: "pic@example.com", creator: " " },
    creatorEmail: "creator@example.com",
  }), true);
});

test("Sheet row authorization allows Creator only when column I has an email", () => {
  const row = { pic: "pic@example.com", creator: "creator@example.com" };
  assert.equal(isSheetRowUpdateAuthorized({ parsed: { email: "pic@example.com" } }, row), true);
  assert.equal(isSheetRowUpdateAuthorized({ parsed: { email: "creator@example.com" } }, row), true);
  assert.equal(isSheetRowUpdateAuthorized({ parsed: { email: "other@example.com" } }, row), false);
  assert.equal(isSheetRowUpdateAuthorized({ parsed: {} }, row), false);
  assert.equal(isSheetRowUpdateAuthorized({ parsed: { email: "creator@example.com" } }, { ...row, creator: "" }), false);
  assert.equal(isSheetRowUpdateAuthorized({ parsed: { email: "pic@example.com" } }, { ...row, creator: "" }), true);
});

test("Creator edits route update DMs to the PIC employee code", () => {
  assert.equal(resolveSheetUpdatePicEmployeeCode({
    requesterEmail: "creator@example.com",
    picEmail: "pic@example.com",
    requesterEmployeeCode: "creator-code",
    knownPicEmployeeCode: "pic-code",
  }), "pic-code");
  assert.equal(resolveSheetUpdatePicEmployeeCode({
    requesterEmail: "PIC@example.com",
    picEmail: "pic@example.com",
    requesterEmployeeCode: "pic-code",
    knownPicEmployeeCode: null,
  }), "pic-code");
  assert.equal(resolveSheetUpdatePicEmployeeCode({
    requesterEmail: "creator@example.com",
    picEmail: "pic@example.com",
    requesterEmployeeCode: "creator-code",
    knownPicEmployeeCode: null,
  }), null);
});

test("Sheet update preserves the existing Creator when omitted from update fields", async () => {
  const client = new GoogleSheetsClient({
    spreadsheetId: "sheet-id",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    oauthRedirectUri: "http://localhost:3030/auth/google/callback",
    tokenPath: "test/.oauth-not-used.json",
  });
  client.tokens = { access_token: "access-token", expiresAt: Date.now() + 120_000 };
  client.readValues = async (range) => {
    assert.equal(range, "Sheet1!A2:I2");
    return [[5, "Task", "pic@example.com", "25/09/2026", "P2", "IN PROGRESS", "created", "updated", "creator@example.com"]];
  };
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let requestBody;
  try {
    globalThis.fetch = async (url, options) => {
      requestUrl = String(url);
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ updatedRange: "Sheet1!A2:I2" }) };
    };
    const result = await client.updateTask(2, {
      id: 5,
      task: "Task",
      pic: "pic@example.com",
      deadline: "26/09/2026",
      priority: "P1",
      status: "DONE",
      createdAt: "created",
      updatedAt: "new-updated",
    });
    assert.match(decodeURIComponent(requestUrl), /Sheet1!A2:I2/);
    assert.equal(requestBody.values[0].length, 9);
    assert.equal(requestBody.values[0][8], "creator@example.com");
    assert.equal(result.updatedRange, "Sheet1!A2:I2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("conditional Sheet status update re-reads before writing and preserves the whole row", async () => {
  const client = new GoogleSheetsClient({
    spreadsheetId: "sheet-id",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    oauthRedirectUri: "http://localhost:3030/auth/google/callback",
    tokenPath: "test/.oauth-not-used.json",
  });
  client.tokens = { access_token: "access-token", expiresAt: Date.now() + 120_000 };
  let currentStatus = "TODO";
  client.readValues = async (range) => {
    assert.equal(range, "Sheet1!A7:I7");
    return [[42, "Task", "pic@example.com", "30/09/2026", "P1", currentStatus, "created", "old-updated", "creator@example.com"]];
  };
  const originalFetch = globalThis.fetch;
  let requestBody;
  try {
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ updatedRange: "Sheet1!A7:I7" }) };
    };
    const result = await client.updateTaskIfStatus(7, {
      id: 42,
      status: "IN PROGRESS",
      updatedAt: "new-updated",
    }, "TODO");
    assert.equal(result.updated, true);
    assert.equal(requestBody.values[0][5], "IN PROGRESS");
    assert.equal(requestBody.values[0][8], "creator@example.com");

    currentStatus = "DONE";
    requestBody = null;
    const unchanged = await client.updateTaskIfStatus(7, {
      id: 42,
      status: "IN PROGRESS",
      updatedAt: "must-not-write",
    }, "TODO");
    assert.equal(unchanged.updated, false);
    assert.equal(unchanged.task.status, "DONE");
    assert.equal(requestBody, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
