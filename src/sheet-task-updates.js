function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLocaleLowerCase("vi-VN")
    .replace(/[^\p{L}\p{N}@._#-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const UPDATE_FIELD_PATTERN = /\b(?:priority|uu tien|muc do uu tien|do uu tien|p0|p1|p2|deadline|han(?: chot| hoan thanh)?|due date|status|trang thai|done|not do|not done|in progress|hoan thanh|da xong|dang lam|dang thuc hien|chua xong)\b/i;
const UNSUPPORTED_FIELD_PATTERN = /\b(?:pic|nguoi phu trach|phu trach|giao cho)\b/i;
const UPDATE_VERB_PATTERN = /\b(?:doi|sua|update|cap nhat|chinh|thay|change|set)\b/i;

function cleanTargetQuery(value) {
  return String(value || "")
    .replace(/\b(?:doi|sua|update|cap nhat|chinh|thay|change|set)\b/gi, " ")
    .replace(/\b(?:deadline|han(?: chot| hoan thanh)?|due date|priority|uu tien|muc do uu tien|do uu tien)\b/gi, " ")
    .replace(/\b(?:sang|thanh|la|to|ve|cho|cua)\b/gi, " ")
    .replace(/\b(?:task|cong viec)\b/gi, " ")
    .replace(/\b(?:p0|p1|p2|hom nay|ngay mai|thu [2-7]|thu hai|thu ba|thu tu|thu nam|thu sau|thu bay)\b/gi, " ")
    .replace(/\b\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTaskIntent(text) {
  const value = normalizeSearchText(text);
  if (!value || !UPDATE_VERB_PATTERN.test(value)) return null;

  const hasTargetMarker = /\b(?:task|cong viec|id|ma)\b|#\s*\d+/.test(value);
  if (!hasTargetMarker) return null;

  if (UNSUPPORTED_FIELD_PATTERN.test(value) && !UPDATE_FIELD_PATTERN.test(value)) {
    return {
      intent: "unsupported_update_existing_sheet_task",
      unsupportedFields: value.match(UNSUPPORTED_FIELD_PATTERN)?.[0] || "field",
    };
  }
  if (!UPDATE_FIELD_PATTERN.test(value)) return null;

  const idMatch = value.match(/(?:\b(?:task|cong viec|id|ma)\s*#?\s*(\d+)\b|#\s*(\d+))/i);
  let query = null;
  if (!idMatch) {
    const fieldIndex = value.search(UPDATE_FIELD_PATTERN);
    const beforeField = fieldIndex >= 0 ? value.slice(0, fieldIndex) : value;
    const afterField = fieldIndex >= 0 ? value.slice(fieldIndex) : "";
    const beforeTask = beforeField.match(/\b(?:task|cong viec)\b\s+(.+)$/i)?.[1] || "";
    const afterTask = afterField.match(/\b(?:task|cong viec)\b\s+(.+?)(?:\s+(?:thanh|la|sang|to|ve)\b|$)/i)?.[1] || "";
    query = cleanTargetQuery(beforeTask || afterTask);
  }

  return {
    intent: "update_existing_sheet_task",
    taskId: idMatch ? Number(idMatch[1] || idMatch[2]) : null,
    query: query || null,
    fields: {
      priority: /\b(?:priority|uu tien|muc do uu tien|do uu tien|p0|p1|p2)\b/i.test(value),
      deadline: /\b(?:deadline|han(?: chot| hoan thanh)?|due date)\b/i.test(value),
      status: /\b(?:status|trang thai|done|not do|not done|in progress|hoan thanh|da xong|dang lam|dang thuc hien|chua xong)\b/i.test(value),
    },
  };
}

function extractRequestedStatus(text) {
  const value = normalizeSearchText(text);
  if (/\b(?:not do|not done|khong lam|huy|cancel(?:led)?)\b/i.test(value)) return "NOT DO";
  if (/\b(?:done|hoan thanh|da xong|completed?|finished?)\b/i.test(value)) return "DONE";
  if (/\b(?:in progress|dang lam|dang thuc hien|chua xong)\b/i.test(value)) return "IN PROGRESS";
  return null;
}

function isStatusOnlyUpdate(intent) {
  return Boolean(
    intent?.intent === "update_existing_sheet_task" &&
    intent.fields?.status &&
    !intent.fields?.priority &&
    !intent.fields?.deadline,
  );
}

function sheetRowToTask(row, rowNumber) {
  if (!Array.isArray(row)) return null;
  const idValue = String(row[0] ?? "").trim();
  if (!/^\d+$/.test(idValue)) return null;
  return {
    id: Number(idValue),
    rowNumber,
    task: String(row[1] ?? "").trim(),
    pic: String(row[2] ?? "").trim(),
    deadline: String(row[3] ?? "").trim(),
    priority: String(row[4] ?? "").trim(),
    status: String(row[5] ?? "").trim() || "IN PROGRESS",
    createdAt: String(row[6] ?? "").trim(),
    updatedAt: String(row[7] ?? "").trim(),
  };
}

function taskRowText(task) {
  return normalizeSearchText([task.task, task.pic, task.status].filter(Boolean).join(" "));
}

function findMatchingSheetTasks(rows, query, maxResults = 10) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(" ").filter((token) => token.length > 1);
  return rows
    .map((row, index) => sheetRowToTask(row, index + 2))
    .filter(Boolean)
    .map((task) => {
      const haystack = taskRowText(task);
      const exact = haystack.includes(normalizedQuery);
      const matchedTokens = tokens.filter((token) => haystack.includes(token)).length;
      return { task, score: exact ? tokens.length + 10 : matchedTokens };
    })
    .filter(({ score }) => score > 0 && (tokens.length <= 1 || score >= Math.max(1, Math.ceil(tokens.length / 2))))
    .sort((a, b) => b.score - a.score || a.task.id - b.task.id)
    .slice(0, maxResults)
    .map(({ task }) => task);
}

export {
  detectTaskIntent,
  extractRequestedStatus,
  isStatusOnlyUpdate,
  findMatchingSheetTasks,
  normalizeSearchText,
  sheetRowToTask,
};
