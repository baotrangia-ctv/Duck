import test from "node:test";
import assert from "node:assert/strict";
import { parseReminderCommand, computeDeadlineStatus, handleTaskReminder } from "../src/task-reminder.js";

test("reminder command accepts accents, mentions, mixed separators, deduplication and a 50-ID cap", () => {
  assert.deepEqual(parseReminderCommand("@Duck_Test Các task sau cần remind: #2,3 4; #2;5"), { taskIds: [2, 3, 4, 5] });
  assert.deepEqual(parseReminderCommand("  CAC TASK SAU CAN REMIND : 6;7,  "), { taskIds: [6, 7] });
  assert.equal(parseReminderCommand(`Các task sau cần remind: ${Array.from({ length: 60 }, (_, i) => i + 1).join(",")}`).taskIds.length, 50);
  for (const text of ["Các task sau cần remind:", "Các task sau cần remind: abc", "Các task sau cần remind: 0", "Các task sau cần remind: -2", "Các task sau cần remind: 2.5", "Các task sau cần remind: 2abc", "Các task sau cần remind: 2 làm báo cáo", "Các task sau cần remind 2", "Làm báo cáo task 5", "Đổi status task 5 sang DONE"]) {
    assert.equal(parseReminderCommand(text), null, text);
  }
});

test("deadline status compares valid calendar dates in Vietnam and never throws for invalid input", () => {
  const cases = [
    ["01/11/2026", "2026-10-31T05:00:00Z", "Còn 1 ngày đến Deadline"],
    ["01/01/2027", "2026-12-31T05:00:00Z", "Còn 1 ngày đến Deadline"],
    ["2026-10-27", "2026-10-26T17:01:00Z", "Đã đến Deadline"],
    ["27/10", "2026-10-26T16:59:00Z", "Còn 1 ngày đến Deadline"],
    ["26/10/2026", "2026-10-26T17:01:00Z", "Quá 1 ngày so với Deadline"],
    ["29/02/2028", "2028-02-28T05:00:00Z", "Còn 1 ngày đến Deadline"],
  ];
  for (const [deadline, now, expected] of cases) assert.equal(computeDeadlineStatus(deadline, now), expected);
  for (const deadline of ["", null, undefined, "nonsense", "31/02/2026", "29/02/2026", "2026-13-01", "00/10", "01/00/2026", {}]) {
    assert.equal(computeDeadlineStatus(deadline, "2026-10-27T00:00:00Z"), "Chưa xác định Deadline");
  }
  assert.equal(computeDeadlineStatus("27/10", "bad date"), "Chưa xác định Deadline");
});

function dependencies() {
  const sent = [], remembered = [], reads = [];
  return {
    sent, remembered, reads,
    googleSheets: {
      isConfigured: () => true, isAuthorized: () => true,
      findTaskById: async (id) => { reads.push(id); return { id, pic: "pic@example.com", task: "Làm báo cáo", status: "TODO" }; },
    },
    seatalk: { isConfigured: () => true, sendSingleChat: async (code, card) => { sent.push({ code, card }); return { message_id: `card-${sent.length}` }; } },
    resolvePicEmployeeCode: async () => "pic-code",
    rememberSheetMessage: (messageId, id) => remembered.push({ messageId, id }),
    now: () => "2026-10-27T05:00:00Z",
  };
}

test("each task produces a separate DM even for the same PIC, and remembers card IDs", async () => {
  const deps = dependencies();
  assert.deepEqual(await handleTaskReminder([2, 3], {}, deps), { sent: [2, 3], skipped: [], failed: [] });
  assert.deepEqual(deps.reads, [2, 3]);
  assert.deepEqual(deps.sent.map(({ code }) => code), ["pic-code", "pic-code"]);
  assert.deepEqual(deps.sent.map(({ card }) => card.interactive_message.elements[2].button.value), ["task:done:2", "task:done:3"]);
  assert.deepEqual(deps.remembered, [{ messageId: "card-1", id: 2 }, { messageId: "card-2", id: 3 }]);
});

test("missing tasks, PIC, codes, final statuses and per-ID errors do not stop later reminders", async () => {
  const deps = dependencies();
  deps.googleSheets.findTaskById = async (id) => {
    if (id === 1) return null;
    if (id === 7) throw new Error("read failed");
    return { id, pic: id === 2 ? "" : "pic@example.com", status: id === 4 ? "DONE" : id === 5 ? "NOT DO" : "TODO" };
  };
  deps.resolvePicEmployeeCode = async (task) => task.id === 3 ? null : "pic-code";
  deps.seatalk.sendSingleChat = async (code, card) => {
    if (card.interactive_message.elements[2].button.value === "task:done:6") throw new Error("DM failed");
    deps.sent.push(card);
    return { data: { message_id: "last-card" } };
  };
  const result = await handleTaskReminder([1, 2, 3, 4, 5, 6, 7, 8], {}, deps);
  assert.deepEqual(result.sent, [8]);
  assert.deepEqual(result.skipped.map(({ id }) => id), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.failed, [{ id: 6, error: "DM failed" }, { id: 7, error: "read failed" }]);
  assert.ok(result.skipped.every(({ reason }) => reason));
  assert.deepEqual(deps.remembered, [{ messageId: "last-card", id: 8 }]);
});

test("integration gates prevent all reads and DMs", async () => {
  for (const [integration, gate] of [["googleSheets", "isConfigured"], ["googleSheets", "isAuthorized"], ["seatalk", "isConfigured"]]) {
    const deps = dependencies();
    deps[integration][gate] = () => false;
    const result = await handleTaskReminder([1, 2], {}, deps);
    assert.equal(result.failed.length, 2);
    assert.deepEqual(deps.reads, []);
    assert.deepEqual(deps.sent, []);
  }
});
