import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseReminderCommand, handleTaskReminder } from "../src/task-reminder.js";
import { detectTaskIntent } from "../src/sheet-task-updates.js";
import { parseConfirmationButtonValue } from "../src/confirmation-routing.js";

// Evaluate orchestration functions alone: importing server.js would load local credentials and listen.
const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
function serverFunction(name, nextName, globals) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start);
  const declaration = source.slice(source.slice(start - 6, start) === "async " ? start - 6 : start, end).replace(/async\s*$/, "");
  return runInNewContext(`${declaration}; ${name}`, globals);
}

function setup() {
  const patches = [], replies = [], sent = [], remembered = [];
  const globals = {
    parseReminderCommand, handleTaskReminder, detectTaskIntent,
    updateProcessing: (record, patch) => patches.push(patch),
    sendSheetUpdateText: async (record, text) => replies.push(text),
    rememberSheetMessage: (messageId, id) => remembered.push({ messageId, id }),
    findInMemoryTaskBySheetId: (id) => id === 2 ? { picEmployeeCode: "memory-code" } : null,
    googleSheets: { isConfigured: () => true, isAuthorized: () => true, findTaskById: async (id) => ({ id, pic: "pic@example.com", status: "TODO" }) },
    seatalk: {
      isConfigured: () => true,
      getEmployeeCodeByEmail: async () => "lookup-code",
      sendSingleChat: async (code, card) => { sent.push({ code, card }); return { message_id: `card-${sent.length}` }; },
    },
  };
  return { patches, replies, sent, remembered, globals };
}

test("server intercepts reminders before quote, intent, extraction or draft routing and sends one summary", async () => {
  const context = setup();
  context.globals.detectTaskIntent = () => { throw new Error("must intercept before intent"); };
  const process = serverFunction("processTask", "sendConfirmationResult", context.globals);
  await process({ parsed: { text: "@Duck_Test Các task sau cần remind: 2,3", quotedMessageId: "unrelated" } });
  assert.deepEqual(context.sent.map(({ code }) => code), ["memory-code", "lookup-code"]);
  assert.equal(context.replies.length, 1);
  assert.match(context.replies[0], /#2, #3/);
  assert.equal(context.remembered.length, 2);
  assert.equal(context.patches.at(-1).sheet.status, "reminded");
});

test("skipSheet reminder dry run parses IDs without any Sheet read or outbound call", async () => {
  const context = setup();
  context.globals.googleSheets = new Proxy({}, { get() { throw new Error("unexpected Sheet access"); } });
  context.globals.seatalk = new Proxy({}, { get() { throw new Error("unexpected SeaTalk access"); } });
  await serverFunction("processTask", "sendConfirmationResult", context.globals)({ parsed: { text: "Các task sau cần remind: 2,3" } }, { skipSheet: true });
  assert.equal(context.patches.at(-1).sheet.status, "skipped");
  assert.deepEqual(context.patches.at(-1).sheet.taskIds, [2, 3]);
  assert.equal(context.replies.length, 0);
});

test("ordinary new-task and status-update messages still follow existing routes", async () => {
  const context = setup();
  const routes = [];
  Object.assign(context.globals, {
    findSessionTaskByMessageId: () => null,
    getThreadSession: () => ({}),
    resolveTaskRoute: () => ({ kind: "new" }),
    createNewTask: () => ({ draftId: "new" }),
    processTaskForTask: async () => routes.push("new"),
    processSheetTaskUpdate: async (record, intent) => routes.push(intent.taskId),
  });
  const process = serverFunction("processTask", "sendConfirmationResult", context.globals);
  await process({ parsed: { text: "Làm báo cáo trước thứ 6" } });
  await process({ parsed: { text: "Đổi status task 5 sang DONE" } });
  assert.deepEqual(routes, ["new", 5]);
});

test("thread reply filter accepts reminders and existing updates and ignores ordinary replies", () => {
  const shouldProcess = serverFunction("shouldProcessMessage", "handleWebhook", { parseReminderCommand, detectTaskIntent });
  const record = (text) => ({ parsed: { kind: "message", eventType: "new_message_received_from_thread", text } });
  assert.equal(shouldProcess(record("Các task sau cần remind: 2")), true);
  assert.equal(shouldProcess(record("Đổi status task 5 sang DONE")), true);
  assert.equal(shouldProcess(record("cảm ơn")), false);
});

test("webhook dispatches task_done to the DONE handler", async () => {
  const calls = [];
  const record = { id: "event", parsed: { kind: "interaction", buttonValue: "task:done:12" } };
  const handler = serverFunction("handleWebhook", "serveStatic", {
    readRequestBody: async () => Buffer.from("{}"),
    getHeader: () => "", signaturesMatch: () => true,
    addMessage: () => ({ record, duplicate: false }),
    shouldProcessMessage: () => false, parseConfirmationButtonValue,
    markTaskDone: async (value, click) => calls.push({ value, click }),
    sendJson: () => {},
  });
  await handler({}, {});
  assert.deepEqual(calls, [{ value: "task:done:12", click: record }]);
});

test("webhook logs distinguish accepted, verification and rejected events without recording private payloads", async () => {
  for (const scenario of ["accepted", "verification", "signature_missing", "signature_mismatch", "invalid_json", "body_rejected"]) {
    const logs = [], responses = [], records = [];
    const payload = {
      event_type: scenario === "verification" ? "event_verification" : "new_mentioned_message_received_from_group_chat",
      event: { text: { content: "private-message-content" }, email: "private-email@example.com" },
    };
    const handler = serverFunction("handleWebhook", "serveStatic", {
      console: { info: (...args) => logs.push(args.join(" ")) },
      readRequestBody: async () => {
        if (scenario === "body_rejected") throw new Error("body too large");
        return Buffer.from(scenario === "invalid_json" ? "{" : JSON.stringify(payload));
      },
      getHeader: () => scenario === "signature_mismatch" ? "private-signature-value" : "",
      signaturesMatch: () => !scenario.startsWith("signature_"),
      addMessage: (value) => { records.push(value); return { record: { id: "event", parsed: { kind: "event" } }, duplicate: false }; },
      shouldProcessMessage: () => false,
      sendJson: (response, status) => responses.push(status),
    });
    await handler({}, {});
    const expectedStatus = scenario === "body_rejected" ? 413 : scenario === "invalid_json" ? 400 : scenario.startsWith("signature_") ? 401 : 200;
    assert.deepEqual(responses, [expectedStatus]);
    assert.equal(records.length, expectedStatus === 200 ? 1 : 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`"outcome":"${scenario}"`));
    assert.doesNotMatch(logs[0], /private-message-content|private-email|private-signature/);
  }
});
