import test from "node:test";
import assert from "node:assert/strict";
import { GoogleSheetsClient } from "../src/google-sheets.js";
import {
  detectTaskIntent,
  extractRequestedStatus,
  findMatchingSheetTasks,
  isStatusOnlyUpdate,
  sheetRowToTask,
} from "../src/sheet-task-updates.js";
import {
  buildSheetTaskUpdateMessage,
  buildSheetTaskUpdatedMessage,
} from "../src/seatalk.js";
import { parseConfirmationButtonValue } from "../src/confirmation-routing.js";
import { isSheetUpdateClickAuthorized } from "../src/confirmation-auth.js";

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
  assert.equal(isStatusOnlyUpdate(detectTaskIntent("Cập nhật task #18 done")), true);
  assert.equal(detectTaskIntent("Cập nhật dashboard trước deadline"), null);
});

test("Sheet task row parsing and content matching return row numbers", () => {
  const rows = [
    [5, "Update UI/UX SAP", "pic@example.com", "25/09/2026", "P2", "IN PROGRESS", "created", "updated"],
    [6, "Update UI/UX Web", "other@example.com", "26/09/2026", "P1", "IN PROGRESS", "created", "updated"],
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
  });
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
  client.readValues = async () => [
    [5, "Update UI/UX SAP", "pic@example.com", "25/09/2026", "P2", "IN PROGRESS", "created", "updated"],
    [6, "Update UI/UX Web", "other@example.com", "26/09/2026", "P1", "IN PROGRESS", "created", "updated"],
  ];

  assert.equal((await client.findTaskById(5)).rowNumber, 2);
  assert.equal(await client.findTaskById(99), null);
  assert.deepEqual((await client.findTasksByText("ui ux")).map((task) => task.id), [5, 6]);
});

test("Sheet update routes, cards, and permission use the PIC identity", () => {
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
  assert.equal(isSheetUpdateClickAuthorized({ parsed: { email: "pic@example.com" } }, { picEmail: "pic@example.com" }), true);
  assert.equal(isSheetUpdateClickAuthorized({ parsed: { email: "other@example.com" } }, { picEmail: "pic@example.com" }), false);
  assert.equal(isSheetUpdateClickAuthorized({ parsed: {} }, { picEmail: "pic@example.com" }), false);
});
