const DEFAULT_BASE_URL = "https://openapi.seatalk.io";

function asNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function fieldValue(value) {
  return asNonEmptyString(value) || "Chưa xác định";
}

function buildConfirmationMessage(draft, confirmationValue) {
  const description = [
    `PIC: ${fieldValue(draft.pic)}`,
    `Nội dung Task: ${fieldValue(draft.task)}`,
    `Deadline: ${fieldValue(draft.deadline)}`,
    `Priority: ${fieldValue(draft.priority)}`,
  ].join("\n");

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
          button_group: [
            {
              button_type: "callback",
              text: "Xác nhận",
              value: confirmationValue,
            },
          ],
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

function buildConfirmationSuccessMessage() {
  return {
    tag: "text",
    text: { format: 2, content: "✅ Đã gửi thông tin công việc cho PIC" },
  };
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

  async sendReply({ employeeCode = null, groupId = null, threadId = null }, message) {
    if (groupId) return this.sendGroupChat(groupId, message, threadId);
    return this.sendSingleChat(employeeCode, message);
  }

  async sendConfirmation(target, draft, confirmationValue) {
    return this.sendReply(target, buildConfirmationMessage(draft, confirmationValue));
  }
}

export { SeaTalkClient, buildConfirmationMessage, buildConfirmationText, buildConfirmationSuccessMessage, buildTaskAssignmentMessage };
