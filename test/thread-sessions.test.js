import test from "node:test";
import assert from "node:assert/strict";
import {
  createPendingClarification,
  createTask,
  createThreadSession,
  findTaskByMessageId,
  getRecentTasks,
  reopenTaskForConfirmation,
  resolveTaskRoute,
} from "../src/thread-sessions.js";
import { isClarificationClickAuthorized } from "../src/confirmation-auth.js";
import { parseConfirmationButtonValue } from "../src/confirmation-routing.js";
import {
  buildConfirmationMessage,
  buildConfirmedMessage,
  buildTaskClarificationMessage,
} from "../src/seatalk.js";

test("thread router creates a new task, asks for clarification, and routes a valid quote", () => {
  const session = createThreadSession("group:g1:thread:t1", { groupId: "g1", threadId: "t1" });

  assert.deepEqual(resolveTaskRoute(session, { quotedMessageId: null }), { kind: "new" });

  const task = createTask(session, {
    confirmationMessageId: "card-1",
    assignmentMessageId: "dm-1",
    sourceMessageId: "source-1",
    lastActivityAt: "2026-09-21T10:00:00.000Z",
  });
  assert.deepEqual(resolveTaskRoute(session, { quotedMessageId: null }), { kind: "clarify" });
  assert.deepEqual(resolveTaskRoute(session, { quotedMessageId: "not-a-task-card" }), { kind: "clarify" });
  assert.deepEqual(resolveTaskRoute(session, { quotedMessageId: "card-1" }), { kind: "update", task });
  assert.equal(findTaskByMessageId(session, "dm-1"), task);
  assert.equal(findTaskByMessageId(session, "source-1"), task);
});

test("clarification values target only the sender of the ambiguous message", () => {
  const session = createThreadSession("thread-1");
  const clarification = createPendingClarification(session, {
    recordId: "record-1",
    senderEmail: "creator@example.com",
    senderEmployeeCode: "517816",
    senderSeatalkId: "seatalk-1",
  });

  assert.deepEqual(parseConfirmationButtonValue(`task:clarify:${clarification.clarifyId}:new`), {
    kind: "clarify_new",
    clarifyId: clarification.clarifyId,
  });
  assert.deepEqual(parseConfirmationButtonValue(`task:clarify:${clarification.clarifyId}:target:2`), {
    kind: "clarify_target",
    clarifyId: clarification.clarifyId,
    shortId: "2",
  });
  assert.equal(parseConfirmationButtonValue(`task:clarify:${clarification.clarifyId}:target:x`), null);

  assert.equal(isClarificationClickAuthorized({ parsed: { email: "creator@example.com" } }, clarification), true);
  assert.equal(isClarificationClickAuthorized({ parsed: { employeeCode: "other" } }, clarification), false);
  assert.equal(isClarificationClickAuthorized({ parsed: {} }, clarification), false);
});

test("reopening a confirmed task preserves its Sheet identity", () => {
  const session = createThreadSession("thread-1");
  const task = createTask(session, {
    rowNumber: 14,
    taskId: 13,
    written: true,
    confirmationValue: "task:confirm:draft-1",
    confirmationMessageId: "confirmed-card-1",
  });

  reopenTaskForConfirmation(task);

  assert.equal(task.written, false);
  assert.equal(task.rowNumber, 14);
  assert.equal(task.taskId, 13);
  assert.equal(task.confirmationValue, null);
  assert.equal(task.confirmationMessageId, null);
});

test("clarification card caps task choices at five and respects SeaTalk button limits", () => {
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    shortId: String(index + 1),
    fields: { taskContent: `Task ${index + 1}` },
  }));
  const message = buildTaskClarificationMessage("Đổi deadline", "clarify-1", tasks, true);
  const elements = message.interactive_message.elements;
  const groups = elements.filter((element) => element.element_type === "button_group");
  const buttons = groups.flatMap((group) => group.button_group);

  assert.equal(buttons.length, 6);
  assert.ok(groups.every((group) => group.button_group.length <= 3));
  assert.equal(buttons[0].value, "task:clarify:clarify-1:new");
  assert.equal(buttons[5].value, "task:clarify:clarify-1:target:5");
  assert.match(elements[1].description.text, /Chỉ hiển thị 5 task/);
});

test("confirmation cards display the thread short task ID", () => {
  const draft = {
    shortId: "2",
    pic: "an@example.com",
    task: "Cập nhật dashboard",
    deadline: "30/09/2026",
    priority: "P1",
  };
  const confirmation = buildConfirmationMessage(draft, "task:confirm:draft-2");
  const confirmed = buildConfirmedMessage(draft, "draft-2");

  assert.match(confirmation.interactive_message.elements[1].description.text, /^\*\*Task #2\*\*/);
  assert.match(confirmed.interactive_message.elements[1].description.text, /^\*\*Task #2\*\*/);
});

test("recent task choices are ordered by activity and limited", () => {
  const session = createThreadSession("thread-1");
  createTask(session, { lastActivityAt: "2026-09-20T10:00:00.000Z" });
  createTask(session, { lastActivityAt: "2026-09-22T10:00:00.000Z" });
  createTask(session, { lastActivityAt: "2026-09-21T10:00:00.000Z" });

  assert.deepEqual(getRecentTasks(session, 2).map((task) => task.shortId), ["2", "3"]);
});
