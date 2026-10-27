import { isTaskAcknowledgementAuthorized } from "./confirmation-auth.js";
import { buildTaskDoneMessage } from "./seatalk.js";

const doneQueues = new Map();

async function sendNotice(record, seatalk, content) {
  if (!record?.parsed?.employeeCode || !seatalk?.isConfigured?.()) return "";
  try {
    await seatalk.sendSingleChat(record.parsed.employeeCode, { tag: "text", text: { format: 2, content } });
    return "";
  } catch (error) {
    return error.message;
  }
}

async function finishDoneCard(task, record, { seatalk, updateProcessing }, status, result = {}) {
  const messageId = record?.parsed?.messageId || null;
  let cardError = "";
  try {
    if (!messageId || !seatalk?.isConfigured?.()) throw new Error("Không thể cập nhật card hoàn thành task.");
    await seatalk.updateInteractiveMessage(messageId, buildTaskDoneMessage(task));
  } catch (error) {
    cardError = error.message;
  }
  const noticeError = cardError || status === "already_done"
    ? await sendNotice(record, seatalk, status === "already_done" ? "Task đã DONE." : "✅ Đã hoàn thành task. Google Sheet đã được cập nhật.")
    : "";
  updateProcessing(record, {
    sheet: { status, rowNumber: task.rowNumber, updatedRange: result.updatedRange, error: "" },
    extraction: {
      taskId: task.id, task: task.task, taskContent: task.task, pic: task.pic,
      deadline: task.deadline, priority: task.priority, taskStatus: "DONE", updatedAt: task.updatedAt,
    },
    confirmation: { status, messageId, error: [cardError, noticeError].filter(Boolean).join(" ") },
  });
  return { handled: true, done: true, unchanged: status === "already_done", taskId: task.id, messageId };
}

async function processTaskDone(taskId, record, dependencies) {
  const { googleSheets, googleSheetsWriteEnabled, seatalk, updateProcessing, now = () => new Date().toISOString() } = dependencies;
  updateProcessing(record, { sheet: { status: "checking_done", error: "" }, confirmation: { status: "checking_done", error: "" } });
  const blocked = !googleSheetsWriteEnabled ? "paused"
    : !googleSheets?.isConfigured?.() ? "not_configured"
      : !googleSheets?.isAuthorized?.() ? "auth_required" : "";
  if (blocked) {
    const error = blocked === "paused" ? "Hệ thống đang tắt ghi Google Sheet."
      : "Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet.";
    updateProcessing(record, { sheet: { status: blocked, error }, confirmation: { status: "blocked" } });
    await sendNotice(record, seatalk, error);
    return { handled: true, blocked: true };
  }
  try {
    const task = await googleSheets.findTaskById(taskId);
    if (!task) {
      updateProcessing(record, { sheet: { status: "not_found" }, confirmation: { status: "not_found" } });
      await sendNotice(record, seatalk, `Không tìm thấy Sheet Task ID #${taskId}.`);
      return { handled: true, notFound: true };
    }
    if (!isTaskAcknowledgementAuthorized(record, task)) {
      updateProcessing(record, { sheet: { status: "forbidden", error: "Chỉ PIC của task mới được đánh dấu hoàn thành." }, confirmation: { status: "ignored" } });
      return { handled: true, ignored: true };
    }
    const currentStatus = String(task.status || "TODO").trim().toUpperCase().replace(/\s+/g, " ");
    if (currentStatus === "DONE") return await finishDoneCard(task, record, dependencies, "already_done");
    const updatedAt = now();
    updateProcessing(record, { sheet: { status: "writing", rowNumber: task.rowNumber }, confirmation: { status: "completing" } });
    const result = await googleSheets.updateTaskIfStatus(task.rowNumber, { id: task.id, status: "DONE", updatedAt }, currentStatus);
    if (!result.updated) {
      const current = await googleSheets.findTaskById(taskId);
      const status = current ? "done_unchanged" : "not_found";
      updateProcessing(record, { sheet: { status, rowNumber: current?.rowNumber }, confirmation: { status } });
      await sendNotice(record, seatalk, current
        ? `Task hiện ở trạng thái ${current.status || "TODO"}; chưa ghi thay đổi. Vui lòng kiểm tra và thử lại.`
        : `Không tìm thấy Sheet Task ID #${taskId}.`);
      return { handled: true, unchanged: true, status: current?.status, notFound: !current };
    }
    return await finishDoneCard({ ...task, status: "DONE", updatedAt }, record, dependencies, "done", result);
  } catch (error) {
    updateProcessing(record, { sheet: { status: "failed", error: error.message }, confirmation: { status: "failed", error: error.message } });
    await sendNotice(record, seatalk, "Chưa thể cập nhật trạng thái hoàn thành task trong Google Sheet.");
    return { handled: true, error: error.message };
  }
}

async function handleTaskDone(taskId, record, dependencies) {
  const key = String(taskId);
  const previous = doneQueues.get(key) || Promise.resolve();
  // Install the chain before awaiting so three or more simultaneous clicks remain serialized.
  const operation = previous.catch(() => {}).then(() => processTaskDone(taskId, record, dependencies));
  doneQueues.set(key, operation);
  try {
    return await operation;
  } finally {
    if (doneQueues.get(key) === operation) doneQueues.delete(key);
  }
}

export { handleTaskDone };
