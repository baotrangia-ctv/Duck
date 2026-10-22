import { isTaskAcknowledgementAuthorized } from "./confirmation-auth.js";
import { buildTaskAcknowledgedMessage } from "./seatalk.js";

const acknowledgementQueues = new Map();

function getTaskFields(task) {
  return {
    taskId: task.id,
    task: task.task,
    taskContent: task.task,
    pic: task.pic,
    deadline: task.deadline,
    priority: task.priority,
    taskStatus: task.status,
    creator: task.creator,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function updateAssignmentCard(task, clickRecord, seatalk) {
  const messageId = task.assignmentMessageId || clickRecord?.parsed?.messageId;
  if (!messageId) return { messageId: null, error: "Không xác định được message_id của card task." };
  if (!seatalk?.isConfigured?.()) return { messageId, error: "Chưa cấu hình SeaTalk để cập nhật card nhận task." };

  try {
    await seatalk.updateInteractiveMessage(messageId, buildTaskAcknowledgedMessage(task));
    return { messageId, error: "" };
  } catch (error) {
    return { messageId, error: error.message };
  }
}

async function sendNotice(clickRecord, seatalk, content) {
  const employeeCode = String(clickRecord?.parsed?.employeeCode || "").trim();
  if (!content || !employeeCode || !seatalk?.isConfigured?.()) return "";

  try {
    await seatalk.sendSingleChat(employeeCode, {
      tag: "text",
      text: { format: 2, content },
    });
    return "";
  } catch (error) {
    return error.message;
  }
}

async function recordUnchangedAcknowledgement(task, clickRecord, { seatalk, updateProcessing }, status = task.status) {
  const currentStatus = String(status || "TODO").trim().toUpperCase().replace(/\s+/g, " ");
  const currentTask = { ...task, status: currentStatus };
  const card = await updateAssignmentCard(currentTask, clickRecord, seatalk);
  const notice = currentStatus === "IN PROGRESS"
    ? "Task đã được xác nhận nhận và đang IN PROGRESS."
    : `Task đã ở trạng thái ${currentStatus}; trạng thái không thay đổi.`;
  const noticeError = await sendNotice(clickRecord, seatalk, notice);
  updateProcessing(clickRecord, {
    sheet: {
      status: currentStatus === "IN PROGRESS" ? "already_acknowledged" : "acknowledgement_unchanged",
      rowNumber: task.rowNumber,
      error: "",
    },
    extraction: getTaskFields(currentTask),
    confirmation: {
      status: currentStatus === "IN PROGRESS" ? "already_acknowledged" : "acknowledgement_unchanged",
      messageId: card.messageId,
      error: [card.error, noticeError].filter(Boolean).join(" "),
    },
  });
  return { handled: true, unchanged: true, status: currentStatus, messageId: card.messageId };
}

async function processTaskAcknowledgement(taskId, clickRecord, {
  googleSheets,
  googleSheetsWriteEnabled,
  seatalk,
  updateProcessing,
  now = () => new Date().toISOString(),
}) {
  const record = clickRecord;
  updateProcessing(record, {
    sheet: { status: "checking_acknowledgement", error: "" },
    confirmation: { status: "checking_acknowledgement", error: "" },
  });

  if (!googleSheetsWriteEnabled) {
    updateProcessing(record, { sheet: { status: "paused", error: "GOOGLE_SHEETS_WRITE_ENABLED đang là false." }, confirmation: { status: "blocked" } });
    await sendNotice(clickRecord, seatalk, "Hệ thống đang tắt ghi Google Sheet nên chưa thể xác nhận nhận task.");
    return { handled: true, blocked: true };
  }
  if (!googleSheets?.isConfigured?.()) {
    updateProcessing(record, { sheet: { status: "not_configured", error: "Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet." }, confirmation: { status: "blocked" } });
    await sendNotice(clickRecord, seatalk, "Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet.");
    return { handled: true, blocked: true };
  }
  if (!googleSheets?.isAuthorized?.()) {
    updateProcessing(record, { sheet: { status: "auth_required", error: "Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet." }, confirmation: { status: "blocked" } });
    await sendNotice(clickRecord, seatalk, "Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet.");
    return { handled: true, blocked: true };
  }

  try {
    const task = await googleSheets.findTaskById(taskId);
    if (!task) {
      updateProcessing(record, { sheet: { status: "not_found", error: "Không tìm thấy task trong Google Sheet." }, confirmation: { status: "not_found" } });
      await sendNotice(clickRecord, seatalk, `Không tìm thấy Sheet Task ID #${taskId}.`);
      return { handled: true, notFound: true };
    }
    if (!isTaskAcknowledgementAuthorized(clickRecord, task)) {
      updateProcessing(record, { sheet: { status: "forbidden", error: "Chỉ PIC của task mới được xác nhận nhận task." }, confirmation: { status: "ignored" } });
      return { handled: true, ignored: true };
    }

    const currentStatus = String(task.status || "TODO").trim().toUpperCase().replace(/\s+/g, " ");
    if (currentStatus !== "TODO" && currentStatus !== "TO DO") {
      return recordUnchangedAcknowledgement(task, clickRecord, { seatalk, updateProcessing }, currentStatus);
    }

    const updatedAt = now();
    updateProcessing(record, {
      sheet: { status: "writing", rowNumber: task.rowNumber, error: "" },
      extraction: getTaskFields({ ...task, status: "IN PROGRESS", updatedAt }),
      confirmation: { status: "acknowledging", error: "" },
    });
    const result = await googleSheets.updateTaskIfStatus(task.rowNumber, {
      id: task.id,
      status: "IN PROGRESS",
      updatedAt,
    }, "TODO");
    if (result.notFound) {
      updateProcessing(record, { sheet: { status: "not_found", error: "Không tìm thấy task trong Google Sheet." }, confirmation: { status: "not_found" } });
      await sendNotice(clickRecord, seatalk, `Không tìm thấy Sheet Task ID #${taskId}.`);
      return { handled: true, notFound: true };
    }
    if (!result.updated) {
      return recordUnchangedAcknowledgement(result.task, clickRecord, { seatalk, updateProcessing });
    }
    const acknowledgedTask = { ...task, status: "IN PROGRESS", updatedAt };
    const card = await updateAssignmentCard(acknowledgedTask, clickRecord, seatalk);
    const noticeError = card.error
      ? await sendNotice(clickRecord, seatalk, "✅ Đã nhận task. Trạng thái đã được cập nhật trong Google Sheet.")
      : "";
    updateProcessing(record, {
      sheet: { status: "acknowledged", rowNumber: result.rowNumber, updatedRange: result.updatedRange, error: "" },
      extraction: { ...getTaskFields(acknowledgedTask), updatedAt },
      confirmation: {
        status: "acknowledged",
        messageId: card.messageId,
        error: [card.error, noticeError].filter(Boolean).join(" "),
      },
    });
    return { handled: true, acknowledged: true, updatedAt, messageId: card.messageId, taskId: task.id };
  } catch (error) {
    updateProcessing(record, { sheet: { status: "failed", error: error.message }, confirmation: { status: "failed", error: error.message } });
    await sendNotice(clickRecord, seatalk, "Chưa thể cập nhật trạng thái nhận task trong Google Sheet.");
    return { handled: true, error: error.message };
  }
}

async function handleTaskAcknowledgement(taskId, clickRecord, dependencies) {
  const key = String(taskId);
  const previous = acknowledgementQueues.get(key);
  if (previous) await previous.catch(() => {});

  const operation = processTaskAcknowledgement(taskId, clickRecord, dependencies);
  acknowledgementQueues.set(key, operation);
  try {
    return await operation;
  } finally {
    if (acknowledgementQueues.get(key) === operation) acknowledgementQueues.delete(key);
  }
}

export { handleTaskAcknowledgement };
