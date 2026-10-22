import test from "node:test";
import assert from "node:assert/strict";
import { handleTaskAcknowledgement } from "../src/task-acknowledgement.js";

function makeTask(status = "TODO") {
  return {
    id: 42,
    rowNumber: 7,
    task: "Cập nhật dashboard",
    pic: "pic@example.com",
    deadline: "30/09/2026",
    priority: "P1",
    status,
    createdAt: "created",
    updatedAt: "old-updated",
    creator: "creator@example.com",
  };
}

function makeClickRecord(email = "pic@example.com") {
  return {
    id: "ack-event",
    parsed: {
      email,
      employeeCode: email === "pic@example.com" ? "pic-code" : "creator-code",
      messageId: "assignment-card",
    },
    processing: null,
  };
}

function makeDependencies(task) {
  const updates = [];
  const cards = [];
  const notices = [];
  const writes = [];
  const lookups = [];
  return {
    task,
    updates,
    cards,
    notices,
    writes,
    lookups,
    googleSheets: {
      isConfigured: () => true,
      isAuthorized: () => true,
      findTaskById: async (taskId) => {
        lookups.push(taskId);
        return task;
      },
      updateTaskIfStatus: async (rowNumber, fields, expectedStatus) => {
        if (task.status !== expectedStatus) return { updated: false, task, rowNumber };
        writes.push({ rowNumber, fields });
        Object.assign(task, fields);
        return { taskId: task.id, rowNumber, updatedRange: "Sheet1!A7:I7", updated: true, task };
      },
      updateTask: async (rowNumber, fields) => {
        writes.push({ rowNumber, fields });
        Object.assign(task, fields);
        return { taskId: task.id, rowNumber, updatedRange: "Sheet1!A7:I7" };
      },
    },
    seatalk: {
      isConfigured: () => true,
      updateInteractiveMessage: async (messageId, message) => cards.push({ messageId, message }),
      sendSingleChat: async (employeeCode, message) => notices.push({ employeeCode, message }),
    },
    updateProcessing: (record, patch) => updates.push({ recordId: record.id, patch }),
    now: () => "2026-10-22T05:00:00.000Z",
  };
}

test("PIC acknowledgement updates TODO to IN PROGRESS and preserves Creator", async () => {
  const dependencies = makeDependencies(makeTask());
  const result = await handleTaskAcknowledgement(42, makeClickRecord(), {
    ...dependencies,
    googleSheetsWriteEnabled: true,
  });

  assert.deepEqual(dependencies.lookups, [42]);
  assert.equal(result.acknowledged, true);
  assert.equal(dependencies.writes.length, 1);
  assert.equal(dependencies.writes[0].rowNumber, 7);
  assert.equal(dependencies.writes[0].fields.status, "IN PROGRESS");
  assert.equal(dependencies.writes[0].fields.updatedAt, "2026-10-22T05:00:00.000Z");
  assert.equal(dependencies.writes[0].fields.creator, undefined);
  assert.equal(dependencies.writes[0].fields.task, undefined);
  assert.equal(dependencies.writes[0].fields.priority, undefined);
  assert.equal(dependencies.writes[0].fields.deadline, undefined);
  assert.equal(dependencies.writes[0].fields.id, 42);
  assert.equal(dependencies.task.creator, "creator@example.com");
  assert.equal(dependencies.task.priority, "P1");
  assert.equal(dependencies.task.deadline, "30/09/2026");
  assert.equal(dependencies.cards[0].messageId, "assignment-card");
  assert.equal(dependencies.cards[0].message.interactive_message.elements[0].title.text, "✅ Đã nhận task");
  assert.equal(dependencies.cards[0].message.interactive_message.elements.length, 2);
  assert.equal(dependencies.notices.length, 0);
  assert.equal(dependencies.updates.at(-1).patch.sheet.status, "acknowledged");
});

test("Creator-only acknowledgement is denied", async () => {
  const dependencies = makeDependencies(makeTask());
  const result = await handleTaskAcknowledgement(42, makeClickRecord("creator@example.com"), {
    ...dependencies,
    googleSheetsWriteEnabled: true,
  });

  assert.equal(result.ignored, true);
  assert.equal(dependencies.writes.length, 0);
  assert.equal(dependencies.cards.length, 0);
  assert.equal(dependencies.updates.at(-1).patch.sheet.status, "forbidden");
});

test("repeated and closed-status acknowledgements do not write or downgrade", async () => {
  for (const status of ["IN PROGRESS", "DONE", "NOT DO"]) {
    const dependencies = makeDependencies(makeTask(status));
    const result = await handleTaskAcknowledgement(42, makeClickRecord(), {
      ...dependencies,
      googleSheetsWriteEnabled: true,
    });

    assert.equal(result.unchanged, true);
    assert.equal(dependencies.writes.length, 0);
    assert.equal(dependencies.cards.length, 1);
    assert.equal(dependencies.cards[0].message.interactive_message.elements.length, 2);
    assert.equal(dependencies.cards[0].message.interactive_message.elements[1].description.text.includes(`Status:** ${status}`), true);
    assert.equal(dependencies.notices.length, 1);
    assert.equal(dependencies.notices[0].employeeCode, "pic-code");
    assert.equal(dependencies.updates.at(-1).patch.sheet.status, status === "IN PROGRESS" ? "already_acknowledged" : "acknowledgement_unchanged");
  }
});

test("concurrent acknowledgements serialize so only one TODO write occurs", async () => {
  const dependencies = makeDependencies(makeTask());
  const results = await Promise.all([
    handleTaskAcknowledgement(42, makeClickRecord(), { ...dependencies, googleSheetsWriteEnabled: true }),
    handleTaskAcknowledgement(42, { ...makeClickRecord(), id: "ack-event-2" }, { ...dependencies, googleSheetsWriteEnabled: true }),
  ]);

  assert.equal(dependencies.writes.length, 1);
  assert.equal(dependencies.writes[0].fields.status, "IN PROGRESS");
  assert.equal(results.filter((result) => result.acknowledged).length, 1);
  assert.equal(results.filter((result) => result.unchanged).length, 1);
});

test("acknowledgement honors Google Sheets configuration and write guards", async () => {
  const disabled = makeDependencies(makeTask());
  const disabledResult = await handleTaskAcknowledgement(42, makeClickRecord(), {
    ...disabled,
    googleSheetsWriteEnabled: false,
  });
  assert.equal(disabledResult.blocked, true);
  assert.equal(disabled.lookups.length, 0);

  const unconfigured = makeDependencies(makeTask());
  unconfigured.googleSheets.isConfigured = () => false;
  const unconfiguredResult = await handleTaskAcknowledgement(42, makeClickRecord(), {
    ...unconfigured,
    googleSheetsWriteEnabled: true,
  });
  assert.equal(unconfiguredResult.blocked, true);
  assert.equal(unconfigured.lookups.length, 0);

  const unauthorized = makeDependencies(makeTask());
  unauthorized.googleSheets.isAuthorized = () => false;
  const unauthorizedResult = await handleTaskAcknowledgement(42, makeClickRecord(), {
    ...unauthorized,
    googleSheetsWriteEnabled: true,
  });
  assert.equal(unauthorizedResult.blocked, true);
  assert.equal(unauthorized.lookups.length, 0);
});
