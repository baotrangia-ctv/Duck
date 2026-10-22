import { findMatchingSheetTasks, sheetRowToTask } from "./sheet-task-updates.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

function normalizeSpreadsheetId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/\/spreadsheets\/d\/([^/]+)/i);
  return match ? match[1] : raw;
}

function columnLetter(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function buildTaskRow({ id, task, taskContent, pic, deadline, priority, status, createdAt, updatedAt, creator }) {
  return [[
    Number.isInteger(id) ? id : "",
    task || taskContent || "",
    pic || "",
    deadline || "",
    priority || "",
    status || "TODO",
    createdAt || "",
    updatedAt || createdAt || "",
    String(creator || "").trim().toLowerCase(),
  ]];
}

class GoogleSheetsClient {
  constructor({
    spreadsheetId = "",
    sheetName = "Sheet1",
    range = "A:I",
    tokenProvider = null,
    fetchImpl = (...args) => fetch(...args),
    now = Date.now,
  } = {}) {
    this.spreadsheetId = normalizeSpreadsheetId(spreadsheetId);
    this.sheetName = sheetName;
    this.range = range;
    this.tokenProvider = tokenProvider;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.authorized = this.isConfigured();
    this.sheetAccessCache = null;
    this.appendQueue = Promise.resolve();
  }

  isConfigured() {
    return Boolean(this.spreadsheetId && this.tokenProvider?.isConfigured?.());
  }

  isAuthorized() {
    return this.isConfigured() && this.authorized;
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      authorized: this.isAuthorized(),
      accountEmail: this.tokenProvider?.getAccountEmail?.() || "",
    };
  }

  targetRange() {
    return this.range.includes("!") ? this.range : `${this.sheetName}!${this.range}`;
  }

  async getAccessToken() {
    if (!this.isConfigured()) throw new Error("Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet.");
    try {
      const token = await this.tokenProvider.getAccessToken();
      this.authorized = true;
      return token;
    } catch {
      this.authorized = false;
      throw new Error("Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet.");
    }
  }

  errorForStatus(status) {
    if (status === 403) {
      const email = this.tokenProvider?.getAccountEmail?.() || "service account";
      return new Error(`Chưa truy cập được Google Sheet. Hãy share Sheet cho ${email} với quyền Editor.`);
    }
    if (status === 404) {
      return new Error("Không tìm thấy Google Sheet. Kiểm tra GOOGLE_SHEETS_SPREADSHEET_ID và quyền share.");
    }
    return new Error(`Google Sheets HTTP ${status}`);
  }

  async request(endpoint, options = {}) {
    const token = options.token || await this.getAccessToken();
    const { token: unusedToken, ...requestOptions } = options;
    const response = await this.fetchImpl(endpoint, {
      ...requestOptions,
      headers: { ...(requestOptions.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.authorized = false;
      throw this.errorForStatus(response.status);
    }
    this.authorized = true;
    return response;
  }

  async checkSheetAccess() {
    if (!this.isConfigured()) return null;
    if (this.sheetAccessCache && this.now() - this.sheetAccessCache.checkedAt < 60_000) {
      return this.sheetAccessCache.value;
    }
    const endpoint = `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}?fields=spreadsheetId`;
    let value = false;
    try {
      await this.request(endpoint);
      value = true;
    } catch {
      value = false;
    }
    this.sheetAccessCache = { value, checkedAt: this.now() };
    return value;
  }

  async readValues(range, token) {
    const endpoint = `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const response = await this.request(endpoint, token ? { token } : {});
    const data = await response.json();
    return Array.isArray(data.values) ? data.values : [];
  }

  async findTaskById(taskId) {
    const normalizedId = String(taskId ?? "").trim();
    if (!/^\d+$/.test(normalizedId)) return null;
    const token = await this.getAccessToken();
    const values = await this.readValues(`${this.sheetName}!A2:I`, token);
    for (let index = 0; index < values.length; index += 1) {
      const task = sheetRowToTask(values[index], index + 2);
      if (task && String(task.id) === normalizedId) return task;
    }
    return null;
  }

  async findTasksByText(query, maxResults = 10) {
    const token = await this.getAccessToken();
    const values = await this.readValues(`${this.sheetName}!A2:I`, token);
    return findMatchingSheetTasks(values, query, maxResults);
  }

  async nextTaskId(token) {
    const values = await this.readValues(`${this.sheetName}!A2:A`, token);
    let maxId = 0;
    for (const row of values) {
      const value = String(row?.[0] ?? "").trim();
      if (/^\d+$/.test(value)) maxId = Math.max(maxId, Number(value));
    }
    return maxId + 1;
  }

  async appendTask(task) {
    const operation = this.appendQueue.then(() => this._appendTask(task));
    this.appendQueue = operation.catch(() => {});
    return operation;
  }

  async _appendTask(task) {
    if (!this.isConfigured()) throw new Error("Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet.");
    const token = await this.getAccessToken();
    const taskId = await this.nextTaskId(token);
    const endpoint = `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(this.targetRange())}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const response = await this.request(endpoint, {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: buildTaskRow({ ...task, id: taskId }) }),
    });
    const data = await response.json();
    const updatedRange = data.updates?.updatedRange || "";
    const rowMatch = updatedRange.match(/!(?:[A-Z]+)(\d+)/i);
    return { taskId, updatedRange, rowNumber: rowMatch ? Number(rowMatch[1]) : null };
  }

  async updateTask(rowNumber, task) {
    const operation = this.appendQueue.then(() => this._updateTask(rowNumber, task));
    this.appendQueue = operation.catch(() => {});
    return operation;
  }

  async updateTaskIfStatus(rowNumber, task, expectedStatus) {
    const operation = this.appendQueue.then(() => this._updateTaskIfStatus(rowNumber, task, expectedStatus));
    this.appendQueue = operation.catch(() => {});
    return operation;
  }

  async _updateTaskIfStatus(rowNumber, task, expectedStatus) {
    if (!this.isConfigured()) throw new Error("Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet.");
    if (!Number.isInteger(Number(rowNumber)) || Number(rowNumber) < 2) {
      throw new Error("Không xác định được dòng task cần update trong Google Sheet");
    }
    const token = await this.getAccessToken();
    const row = Number(rowNumber);
    const range = `${this.sheetName}!A${row}:I${row}`;
    const rows = await this.readValues(range, token);
    const currentTask = sheetRowToTask(rows[0], row);
    const taskId = task.id ?? task.taskId;
    if (!currentTask || String(currentTask.id) !== String(taskId)) {
      return { updated: false, notFound: true, task: currentTask, rowNumber: row };
    }
    const currentStatus = String(currentTask.status || "TODO").trim().toUpperCase().replace(/\s+/g, " ");
    const expected = String(expectedStatus || "").trim().toUpperCase().replace(/\s+/g, " ");
    const matchesExpected = currentStatus === expected || (expected === "TODO" && currentStatus === "TO DO");
    if (!matchesExpected) return { updated: false, task: currentTask, rowNumber: row };
    const result = await this._writeTaskRow(row, { ...currentTask, ...task }, token);
    return { ...result, updated: true, task: { ...currentTask, ...task } };
  }

  async _updateTask(rowNumber, task) {
    if (!this.isConfigured()) throw new Error("Google Sheets chưa sẵn sàng. Kiểm tra service account và quyền share Sheet.");
    if (!Number.isInteger(Number(rowNumber)) || Number(rowNumber) < 2) {
      throw new Error("Không xác định được dòng task cần update trong Google Sheet");
    }
    const token = await this.getAccessToken();
    return this._writeTaskRow(Number(rowNumber), task, token);
  }

  async _writeTaskRow(row, task, token) {
    const range = `${this.sheetName}!A${row}:I${row}`;
    let creator = task.creator;
    if (!String(creator || "").trim()) {
      const existingRows = await this.readValues(range, token);
      creator = existingRows[0]?.[8] ?? "";
    }
    const endpoint = `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    const response = await this.request(endpoint, {
      token,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        majorDimension: "ROWS",
        values: buildTaskRow({ ...task, creator, id: task.id ?? task.taskId }),
      }),
    });
    const data = await response.json();
    return { taskId: task.id ?? task.taskId ?? null, updatedRange: data.updatedRange || range, rowNumber: row };
  }
}

export { GoogleSheetsClient, buildTaskRow, columnLetter, normalizeSpreadsheetId };
