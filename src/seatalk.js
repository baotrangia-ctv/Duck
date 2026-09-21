const DEFAULT_BASE_URL = "https://openapi.seatalk.io";

function asNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function fieldValue(value) {
  return asNonEmptyString(value) || "Chưa xác định";
}

function isoDateFromVietnamTime(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDeadlineDate(isoDate) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function getDeadlineQuickPickOptions(now = new Date()) {
  const today = isoDateFromVietnamTime(now);
  const dayOfWeek = new Date(`${today}T12:00:00Z`).getUTCDay();
  const endOfWeek = addDays(today, (7 - dayOfWeek) % 7);
  return [
    { value: "today", label: "Hôm nay", date: formatDeadlineDate(today) },
    { value: "tomorrow", label: "Ngày mai", date: formatDeadlineDate(addDays(today, 1)) },
    { value: "weekend", label: "Cuối tuần này", date: formatDeadlineDate(endOfWeek) },
    { value: "+7d", label: "+7 ngày", date: formatDeadlineDate(addDays(today, 7)) },
  ];
}

function resolveDeadlineQuickPick(value, now = new Date()) {
  return getDeadlineQuickPickOptions(now).find((option) => option.value === value)?.date || null;
}

function confirmationDraftId(confirmationValue) {
  const parts = String(confirmationValue || "").split(":");
  return parts[0] === "task" && parts[1] === "confirm" && parts[2]
    ? parts[2]
    : String(confirmationValue || "draft");
}

function buildConfirmationMessage(draft, confirmationValue) {
  const draftId = confirmationDraftId(confirmationValue);
  const deadline = fieldValue(draft.deadline);
  // SeaTalk allows at most two button_group elements per interactive message.
  // Keep three useful quick picks in one group; free-form deadline edits remain supported.
  const deadlineOptions = getDeadlineQuickPickOptions().slice(0, 3);
  const priority = String(draft.priority || "").trim().toUpperCase();
  const deadlineButtons = deadlineOptions.map((option) => ({
    button_type: "callback",
    text: `${option.date === deadline ? "✅ " : ""}${option.label}`,
    value: `task:deadline:${draftId}:${option.value}`,
  }));
  const description = [
    draft.shortId ? `**Task #${draft.shortId}**` : null,
    `**PIC:** ${fieldValue(draft.pic)}`,
    `**Nội dung Task:** ${fieldValue(draft.task)}`,
    `**Deadline:** ${deadline}`,
    `**Priority:** ${fieldValue(draft.priority)}`,
  ].filter(Boolean).join("\n");

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        {
          element_type: "title",
          title: { text: "Xác nhận task" },
        },
        {
          element_type: "description",
          description: { format: 1, text: description },
        },
        {
          element_type: "button_group",
          button_group: deadlineButtons,
        },
        {
          element_type: "button_group",
          button_group: [
            ...["P0", "P1", "P2"].map((option) => ({
              button_type: "callback",
              text: `${option === priority ? "✅ " : ""}${option}`,
              value: `task:priority:${draftId}:${option}`,
            })),
          ],
        },
        {
          element_type: "button",
          button: {
            button_type: "callback",
            text: "Xác nhận",
            value: confirmationValue,
          },
        },
      ],
    },
  };
}

function buildConfirmedMessage(draft, draftId) {
  const description = [
    draft.shortId ? `**Task #${draft.shortId}**` : null,
    `**PIC:** ${fieldValue(draft.pic)}`,
    `**Nội dung Task:** ${fieldValue(draft.task)}`,
    `**Deadline:** ${fieldValue(draft.deadline)}`,
    `**Priority:** ${fieldValue(draft.priority)}`,
  ].filter(Boolean).join("\n");

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        {
          element_type: "title",
          title: { text: "Xác nhận task" },
        },
        {
          element_type: "description",
          description: { format: 1, text: description },
        },
        {
          element_type: "button",
          button: {
            button_type: "callback",
            text: "✅ Đã gửi thông tin công việc cho PIC",
            value: `task:confirmed:${draftId}`,
          },
        },
      ],
    },
  };
}

function buildTaskClarificationMessage(text, clarifyId, tasks = [], truncated = false) {
  const buttons = [
    {
      button_type: "callback",
      text: "🆕 Tạo task mới",
      value: `task:clarify:${clarifyId}:new`,
    },
    ...tasks.map((task) => ({
      button_type: "callback",
      text: `🔄 Cập nhật #${task.shortId}`,
      value: `task:clarify:${clarifyId}:target:${task.shortId}`,
    })),
  ];
  const buttonGroups = [];
  for (let index = 0; index < buttons.length; index += 3) {
    buttonGroups.push({
      element_type: "button_group",
      button_group: buttons.slice(index, index + 3),
    });
  }
  const taskLines = tasks.map((task) => `#${task.shortId}: ${fieldValue(task.fields?.taskContent || task.fields?.task)}`);
  const description = [
    "Tin nhắn này chưa có quote hợp lệ. Bạn muốn:",
    `\"${fieldValue(text)}\"`,
    "",
    ...taskLines,
    truncated ? "(Chỉ hiển thị 5 task hoạt động gần nhất.)" : null,
  ].filter((line) => line !== null).join("\n");

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        {
          element_type: "title",
          title: { text: "Chọn task cần xử lý" },
        },
        {
          element_type: "description",
          description: { format: 1, text: description },
        },
        ...buttonGroups,
      ],
    },
  };
}

function buildSheetTaskUpdateDescription(draft) {
  return [
    `**Sheet Task #${fieldValue(draft.id)}**`,
    `**PIC:** ${fieldValue(draft.pic)}`,
    `**Nội dung Task:** ${fieldValue(draft.task)}`,
    `**Deadline:** ${fieldValue(draft.deadline)}`,
    `**Priority:** ${fieldValue(draft.priority)}`,
    `**Status:** ${fieldValue(draft.status || "IN PROGRESS")}`,
  ].join("\n");
}

function buildSheetTaskUpdateMessage(draft, updateId) {
  const deadline = fieldValue(draft.deadline);
  const priority = String(draft.priority || "").trim().toUpperCase();
  const deadlineButtons = getDeadlineQuickPickOptions().slice(0, 3).map((option) => ({
    button_type: "callback",
    text: `${option.date === deadline ? "✅ " : ""}${option.label}`,
    value: `task:sheet-update:deadline:${updateId}:${option.value}`,
  }));
  const priorityButtons = ["P0", "P1", "P2"].map((option) => ({
    button_type: "callback",
    text: `${option === priority ? "✅ " : ""}${option}`,
    value: `task:sheet-update:priority:${updateId}:${option}`,
  }));

  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        { element_type: "title", title: { text: "Cập nhật task đã ghi Sheet" } },
        { element_type: "description", description: { format: 1, text: buildSheetTaskUpdateDescription(draft) } },
        { element_type: "button_group", button_group: deadlineButtons },
        { element_type: "button_group", button_group: priorityButtons },
        {
          element_type: "button",
          button: {
            button_type: "callback",
            text: "Xác nhận đổi",
            value: `task:sheet-update:confirm:${updateId}`,
          },
        },
      ],
    },
  };
}

function buildSheetTaskUpdatedMessage(draft, updateId) {
  return {
    tag: "interactive_message",
    interactive_message: {
      elements: [
        { element_type: "title", title: { text: "Đã cập nhật task" } },
        { element_type: "description", description: { format: 1, text: buildSheetTaskUpdateDescription(draft) } },
        {
          element_type: "button",
          button: {
            button_type: "callback",
            text: "✅ Đã cập nhật task",
            value: `task:sheet-update:updated:${updateId}`,
          },
        },
      ],
    },
  };
}

function buildConfirmationText(draft) {
  const content = [
    "Xác nhận task:",
    `PIC: ${fieldValue(draft.pic)}`,
    `Nội dung Task: ${fieldValue(draft.task)}`,
    `Deadline: ${fieldValue(draft.deadline)}`,
    `Priority: ${fieldValue(draft.priority)}`,
  ].join("\n");
  return {
    tag: "text",
    text: { format: "2", content },
  };
}

function buildTaskAssignmentMessage(draft) {
  const content = [
    "Task đã được xác nhận và ghi nhận:",
    ...(draft.taskId !== null && draft.taskId !== undefined ? [`Sheet Task ID: #${fieldValue(draft.taskId)}`] : []),
    `PIC: ${fieldValue(draft.pic)}`,
    `Nội dung Task: ${fieldValue(draft.task)}`,
    `Deadline: ${fieldValue(draft.deadline)}`,
    `Priority: ${fieldValue(draft.priority)}`,
    `Status: ${fieldValue(draft.status || "IN PROGRESS")}`,
  ].join("\n");
  return {
    tag: "text",
    text: { format: "2", content },
  };
}

function buildTaskAssignmentUpdatedMessage(draft) {
  const content = [
    "Task đã được cập nhật trong Google Sheet:",
    ...(draft.taskId !== null && draft.taskId !== undefined ? [`Sheet Task ID: #${fieldValue(draft.taskId)}`] : []),
    `PIC: ${fieldValue(draft.pic)}`,
    `Nội dung Task: ${fieldValue(draft.task)}`,
    `Deadline: ${fieldValue(draft.deadline)}`,
    `Priority: ${fieldValue(draft.priority)}`,
    `Status: ${fieldValue(draft.status || "IN PROGRESS")}`,
  ].join("\n");
  return { tag: "text", text: { format: "2", content } };
}

class SeaTalkClient {
  constructor({
    appId = "",
    appSecret = "",
    accessToken = "",
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.appId = String(appId || "").trim();
    this.appSecret = String(appSecret || "").trim();
    this.accessToken = String(accessToken || "").trim();
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.tokenExpiresAt = this.accessToken ? Number.MAX_SAFE_INTEGER : 0;
  }

  isConfigured() {
    return Boolean(this.accessToken || (this.appId && this.appSecret));
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    if (!this.appId || !this.appSecret) {
      throw new Error("Chưa cấu hình SeaTalk App ID/App Secret để gửi tin nhắn.");
    }

    const response = await this.fetchImpl(`${this.baseUrl}/auth/app_access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || Number(data.code || 0) !== 0 || !data.app_access_token) {
      throw new Error(`SeaTalk cấp access token thất bại: HTTP ${response.status} ${data.message || ""}`.trim());
    }

    this.accessToken = data.app_access_token;
    const expire = Number(data.expire || 0);
    this.tokenExpiresAt = expire > 1_000_000_000_000 ? expire : expire * 1000;
    if (!this.tokenExpiresAt) this.tokenExpiresAt = Date.now() + 7_200_000;
    return this.accessToken;
  }

  async request(path, body) {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || Number(data.code || 0) !== 0) {
      throw new Error(`SeaTalk API lỗi: HTTP ${response.status} ${data.message || `code ${data.code ?? "unknown"}`}`);
    }
    return data;
  }

  async sendSingleChat(employeeCode, message) {
    if (!asNonEmptyString(employeeCode)) throw new Error("Thiếu employee_code để gửi SeaTalk single chat.");
    return this.request("/messaging/v2/single_chat", {
      employee_code: employeeCode,
      message,
      usable_platform: "all",
    });
  }

  async sendGroupChat(groupId, message, threadId = null) {
    if (!asNonEmptyString(groupId)) throw new Error("Thiếu group_id để gửi SeaTalk group chat.");
    const groupMessage = asNonEmptyString(threadId)
      ? { ...message, thread_id: threadId }
      : message;
    return this.request("/messaging/v2/group_chat", {
      group_id: groupId,
      message: groupMessage,
    });
  }

  async updateInteractiveMessage(messageId, message) {
    if (!asNonEmptyString(messageId)) throw new Error("Thiếu message_id để cập nhật SeaTalk interactive message.");
    return this.request("/messaging/v2/update", {
      message_id: messageId,
      message,
    });
  }

  async sendReply({ employeeCode = null, groupId = null, threadId = null }, message) {
    if (groupId) return this.sendGroupChat(groupId, message, threadId);
    return this.sendSingleChat(employeeCode, message);
  }

  async sendConfirmation(target, draft, confirmationValue) {
    return this.sendReply(target, buildConfirmationMessage(draft, confirmationValue));
  }
}

export {
  SeaTalkClient,
  buildConfirmationMessage,
  buildConfirmedMessage,
  buildTaskClarificationMessage,
  buildSheetTaskUpdateMessage,
  buildSheetTaskUpdatedMessage,
  buildConfirmationText,
  buildTaskAssignmentMessage,
  buildTaskAssignmentUpdatedMessage,
  getDeadlineQuickPickOptions,
  resolveDeadlineQuickPick,
};
