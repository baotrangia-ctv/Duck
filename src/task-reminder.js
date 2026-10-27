import { normalizeSearchText } from "./sheet-task-updates.js";
import { buildTaskReminderMessage } from "./seatalk.js";
export { computeDeadlineStatus } from "./deadline-status.js";

function parseReminderCommand(text) {
  const match = String(text ?? "").trim().match(/^(.*?)\s*:\s*([\s\S]*)$/);
  if (!match) return null;
  const command = normalizeSearchText(match[1]).replace(/^(?:@\S+\s+)+/, "");
  if (command !== "cac task sau can remind") return null;
  const list = match[2].trim();
  if (!/^(?:#?\d+)(?:[\s,;]+#?\d+)*[\s,;]*$/.test(list)) return null;
  const taskIds = [...new Set((list.match(/\d+/g) || []).map(Number))]
    .filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 50);
  return taskIds.length ? { taskIds } : null;
}

async function handleTaskReminder(taskIds, record, {
  googleSheets, seatalk, resolvePicEmployeeCode, now = () => new Date(),
  rememberSheetMessage = () => {},
}) {
  const result = { sent: [], skipped: [], failed: [] };
  const unavailable = !googleSheets?.isConfigured?.() || !googleSheets?.isAuthorized?.()
    ? "Google Sheets chưa sẵn sàng hoặc chưa được cấp quyền."
    : !seatalk?.isConfigured?.() ? "Chưa cấu hình SeaTalk." : "";
  for (const id of taskIds) {
    if (unavailable) {
      result.failed.push({ id, error: unavailable });
      continue;
    }
    try {
      const task = await googleSheets.findTaskById(id);
      let reason = "";
      if (!task) reason = "Không tìm thấy task.";
      else if (["DONE", "NOT DO"].includes(String(task.status || "").trim().toUpperCase().replace(/\s+/g, " "))) reason = `Task đã ${task.status}.`;
      else if (!/^[^\s@]+@[^\s@]+$/.test(String(task.pic || "").trim())) reason = "Thiếu email PIC.";
      if (reason) {
        result.skipped.push({ id, reason });
        continue;
      }
      const employeeCode = await resolvePicEmployeeCode(task, record);
      if (!employeeCode) {
        result.skipped.push({ id, reason: "Không tìm thấy employee_code của PIC." });
        continue;
      }
      const response = await seatalk.sendSingleChat(employeeCode, buildTaskReminderMessage(task, { now: now() }));
      result.sent.push(id);
      const messageId = response?.message_id || response?.data?.message_id;
      if (messageId) rememberSheetMessage(messageId, id);
    } catch (error) {
      result.failed.push({ id, error: error.message });
    }
  }
  return result;
}

export { parseReminderCommand, handleTaskReminder };
