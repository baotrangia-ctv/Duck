import test from "node:test";
import assert from "node:assert/strict";
import { handleTaskDone } from "../src/task-done.js";

function setup(status = "IN PROGRESS") {
  const task = { id: 42, rowNumber: 7, task: "Báo cáo", pic: "pic@example.com", creator: "creator@example.com", status, updatedAt: "old" };
  const writes = [], patches = [], cards = [], notices = [], reads = [];
  const record = { id: "click", parsed: { email: "pic@example.com", employeeCode: "PIC", messageId: "reminder-card" } };
  const deps = {
    googleSheetsWriteEnabled: true,
    googleSheets: {
      isConfigured: () => true, isAuthorized: () => true,
      findTaskById: async (id) => { reads.push(id); return { ...task }; },
      updateTaskIfStatus: async (row, fields, expected) => {
        writes.push({ row, fields, expected });
        Object.assign(task, fields);
        return { updated: true, rowNumber: row, updatedRange: "Sheet1!A7:I7" };
      },
    },
    seatalk: {
      isConfigured: () => true,
      updateInteractiveMessage: async (id, card) => cards.push({ id, card }),
      sendSingleChat: async (code, message) => notices.push({ code, message }),
    },
    updateProcessing: (record, patch) => patches.push(patch),
    now: () => "2026-10-27T05:00:00Z",
  };
  return { task, deps, record, writes, patches, cards, notices, reads };
}

test("PIC completes task with status CAS, UpdatedAt and clicked reminder card", async () => {
  const context = setup();
  context.task.assignmentMessageId = "original-assignment";
  const result = await handleTaskDone(42, context.record, context.deps);
  assert.equal(result.done, true);
  assert.deepEqual(context.writes, [{ row: 7, fields: { id: 42, status: "DONE", updatedAt: "2026-10-27T05:00:00Z" }, expected: "IN PROGRESS" }]);
  assert.equal(context.task.creator, "creator@example.com");
  assert.equal(context.cards[0].id, "reminder-card");
  assert.equal(context.cards[0].card.interactive_message.elements.length, 2);
  assert.equal(context.patches.at(-1).sheet.status, "done");
});

test("only current Sheet PIC email may mark DONE, including after restart or reassignment", async () => {
  for (const email of ["creator@example.com", "other@example.com", null]) {
    const context = setup();
    context.record.parsed.email = email;
    const result = await handleTaskDone(42, context.record, context.deps);
    assert.equal(result.ignored, true);
    assert.equal(context.writes.length, 0);
    assert.equal(context.cards.length, 0);
  }
  const context = setup();
  context.task.pic = "new-pic@example.com";
  assert.equal((await handleTaskDone(42, context.record, context.deps)).ignored, true);
});

test("already DONE updates the card and sends a notice without writing", async () => {
  const context = setup("DONE");
  assert.equal((await handleTaskDone(42, context.record, context.deps)).unchanged, true);
  assert.equal(context.writes.length, 0);
  assert.equal(context.cards.length, 1);
  assert.equal(context.notices[0].message.text.content, "Task đã DONE.");
});

test("write flag and Sheets gates block before reading", async () => {
  for (const gate of ["write", "configured", "authorized"]) {
    const context = setup();
    if (gate === "write") context.deps.googleSheetsWriteEnabled = false;
    if (gate === "configured") context.deps.googleSheets.isConfigured = () => false;
    if (gate === "authorized") context.deps.googleSheets.isAuthorized = () => false;
    assert.equal((await handleTaskDone(42, context.record, context.deps)).blocked, true);
    assert.equal(context.reads.length, 0);
    assert.equal(context.writes.length, 0);
  }
});

test("CAS miss re-reads and reports the current state without completing the card", async () => {
  const context = setup();
  context.deps.googleSheets.updateTaskIfStatus = async () => {
    context.task.status = "NOT DO";
    return { updated: false, task: context.task };
  };
  const result = await handleTaskDone(42, context.record, context.deps);
  assert.equal(result.unchanged, true);
  assert.equal(result.status, "NOT DO");
  assert.equal(context.reads.length, 2);
  assert.equal(context.cards.length, 0);
  assert.match(context.notices[0].message.text.content, /NOT DO/);
});

test("missing row and deleted row during CAS do not write DONE", async () => {
  for (const duringWrite of [false, true]) {
    const context = setup();
    if (duringWrite) {
      context.deps.googleSheets.updateTaskIfStatus = async () => {
        context.deps.googleSheets.findTaskById = async () => null;
        return { updated: false, notFound: true };
      };
    } else context.deps.googleSheets.findTaskById = async () => null;
    assert.equal((await handleTaskDone(42, context.record, context.deps)).notFound, true);
    assert.equal(context.writes.length, 0);
    assert.equal(context.cards.length, 0);
  }
});

test("three simultaneous clicks are serialized and write once", async () => {
  const context = setup("TODO");
  let active = 0, maxActive = 0;
  const lookup = context.deps.googleSheets.findTaskById;
  context.deps.googleSheets.findTaskById = async (id) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    const task = await lookup(id);
    active--;
    return task;
  };
  const results = await Promise.all(Array.from({ length: 3 }, () => handleTaskDone(42, context.record, context.deps)));
  assert.equal(maxActive, 1);
  assert.equal(context.writes.length, 1);
  assert.equal(results.filter(({ unchanged }) => unchanged).length, 2);
});

test("failed card replacement falls back to PIC text while preserving successful Sheet status", async () => {
  const context = setup();
  context.deps.seatalk.updateInteractiveMessage = async () => { throw new Error("card error"); };
  assert.equal((await handleTaskDone(42, context.record, context.deps)).done, true);
  assert.equal(context.task.status, "DONE");
  assert.equal(context.notices[0].code, "PIC");
  assert.match(context.notices[0].message.text.content, /Đã hoàn thành/);
  assert.equal(context.patches.at(-1).sheet.status, "done");
  assert.match(context.patches.at(-1).confirmation.error, /card error/);
});

test("write failure is reported and a later click can retry", async () => {
  const context = setup();
  const write = context.deps.googleSheets.updateTaskIfStatus;
  context.deps.googleSheets.updateTaskIfStatus = async () => { throw new Error("write failed"); };
  assert.equal((await handleTaskDone(42, context.record, context.deps)).error, "write failed");
  assert.equal(context.patches.at(-1).sheet.status, "failed");
  context.deps.googleSheets.updateTaskIfStatus = write;
  assert.equal((await handleTaskDone(42, context.record, context.deps)).done, true);
});
