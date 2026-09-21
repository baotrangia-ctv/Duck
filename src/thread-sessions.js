function createThreadSession(key, target = {}) {
  return {
    key,
    target: {
      groupId: target.groupId || null,
      employeeCode: target.employeeCode || null,
      threadId: target.threadId || null,
    },
    nextTaskSeq: 1,
    nextClarifySeq: 1,
    tasks: new Map(),
    pendingClarifications: new Map(),
  };
}

function createTask(session, data = {}) {
  const task = {
    shortId: String(session.nextTaskSeq++),
    threadKey: session.key,
    draftId: data.draftId || null,
    fields: data.fields || null,
    history: Array.isArray(data.history) ? [...data.history] : [],
    recordId: data.recordId || null,
    createdAt: data.createdAt || null,
    lastActivityAt: data.lastActivityAt || data.createdAt || null,
    rowNumber: data.rowNumber || null,
    taskId: data.taskId || null,
    written: Boolean(data.written),
    confirmationValue: data.confirmationValue || null,
    confirmationMessageId: data.confirmationMessageId || null,
    assignmentMessageId: data.assignmentMessageId || null,
    confirmPromise: null,
    fieldUpdatePromise: null,
    creatorEmail: data.creatorEmail || null,
    creatorEmployeeCode: data.creatorEmployeeCode || null,
    creatorSeatalkId: data.creatorSeatalkId || null,
    sourceMessageId: data.sourceMessageId || null,
    picEmployeeCode: data.picEmployeeCode || null,
  };
  session.tasks.set(task.shortId, task);
  return task;
}

function findTaskByConfirmationMessageId(session, messageId) {
  const value = String(messageId || "").trim();
  if (!value) return null;
  return [...session.tasks.values()].find((task) => task.confirmationMessageId === value) || null;
}

function findTaskByMessageId(session, messageId) {
  const value = String(messageId || "").trim();
  if (!value) return null;
  return [...session.tasks.values()].find((task) =>
    task.confirmationMessageId === value || task.assignmentMessageId === value || task.sourceMessageId === value,
  ) || null;
}

function getRecentTasks(session, limit = 5) {
  return [...session.tasks.values()]
    .sort((a, b) => String(b.lastActivityAt || b.createdAt || "").localeCompare(String(a.lastActivityAt || a.createdAt || "")))
    .slice(0, limit);
}

function createPendingClarification(session, data = {}) {
  const clarification = {
    clarifyId: data.clarifyId || `clarify-${session.nextClarifySeq++}`,
    threadKey: session.key,
    recordId: data.recordId || null,
    senderEmail: data.senderEmail || null,
    senderEmployeeCode: data.senderEmployeeCode || null,
    senderSeatalkId: data.senderSeatalkId || null,
    clarifyMessageId: data.clarifyMessageId || null,
    promise: null,
  };
  session.pendingClarifications.set(clarification.clarifyId, clarification);
  return clarification;
}

function resolveTaskRoute(session, parsed) {
  const quotedTask = findTaskByConfirmationMessageId(session, parsed?.quotedMessageId);
  if (quotedTask) return { kind: "update", task: quotedTask };
  if (session.tasks.size === 0) return { kind: "new" };
  return { kind: "clarify" };
}

function reopenTaskForConfirmation(task) {
  task.written = false;
  task.confirmationValue = null;
  task.confirmationMessageId = null;
  return task;
}

export {
  createThreadSession,
  createTask,
  findTaskByConfirmationMessageId,
  findTaskByMessageId,
  getRecentTasks,
  createPendingClarification,
  resolveTaskRoute,
  reopenTaskForConfirmation,
};
