import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "openid",
  "email",
  "profile",
];

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

function buildTaskRow({ id, task, taskContent, pic, deadline, priority, status, createdAt, updatedAt }) {
  return [[
    Number.isInteger(id) ? id : "",
    task || taskContent || "",
    pic || "",
    deadline || "",
    priority || "",
    status || "IN PROGRESS",
    createdAt || "",
    updatedAt || createdAt || "",
  ]];
}

class GoogleSheetsClient {
  constructor({
    spreadsheetId = "",
    sheetName = "Sheet1",
    range = "A:H",
    oauthClientId = "",
    oauthClientSecret = "",
    oauthRedirectUri = "",
    tokenPath = ".oauth/google-token.json",
  } = {}) {
    this.spreadsheetId = normalizeSpreadsheetId(spreadsheetId);
    this.sheetName = sheetName;
    this.range = range;
    this.oauthClientId = oauthClientId;
    this.oauthClientSecret = oauthClientSecret;
    this.oauthRedirectUri = oauthRedirectUri;
    this.tokenPath = tokenPath;
    this.tokens = null;
    this.appendQueue = Promise.resolve();
    this.loadTokens();
  }

  isConfigured() {
    return Boolean(
      this.spreadsheetId &&
        this.oauthClientId &&
        this.oauthClientSecret &&
        this.oauthRedirectUri
    );
  }

  isAuthorized() {
    this.loadTokens();
    return Boolean(this.tokens?.refresh_token || this.tokens?.access_token);
  }

  getStatus() {
    this.loadTokens();
    return {
      configured: this.isConfigured(),
      authorized: this.isAuthorized(),
      accountEmail: this.tokens?.accountEmail || "",
    };
  }

  getAuthorizationUrl(state) {
    if (!this.isConfigured()) {
      throw new Error("Google OAuth chưa được cấu hình");
    }

    const params = new URLSearchParams({
      client_id: this.oauthClientId,
      redirect_uri: this.oauthRedirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${params}`;
  }

  loadTokens() {
    if (this.tokens || !this.tokenPath || !existsSync(this.tokenPath)) return;
    try {
      this.tokens = JSON.parse(readFileSync(this.tokenPath, "utf8"));
    } catch {
      this.tokens = null;
    }
  }

  saveTokens(tokens) {
    this.tokens = { ...this.tokens, ...tokens };
    mkdirSync(dirname(this.tokenPath), { recursive: true });
    writeFileSync(this.tokenPath, `${JSON.stringify(this.tokens, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async authorizeWithCode(code) {
    if (!this.isConfigured()) {
      throw new Error("Google OAuth chưa được cấu hình");
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
        redirect_uri: this.oauthRedirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) {
      throw new Error(`Google OAuth HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const data = await response.json();
    const accountEmail = await this.fetchAccountEmail(data.access_token);
    this.saveTokens({
      ...data,
      accountEmail: accountEmail || this.tokens?.accountEmail || "",
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    });
    return this.getStatus();
  }

  async fetchAccountEmail(accessToken) {
    if (!accessToken) return "";
    try {
      const response = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return "";
      const data = await response.json();
      return data.email || "";
    } catch {
      return "";
    }
  }

  disconnect() {
    this.tokens = null;
    if (this.tokenPath && existsSync(this.tokenPath)) unlinkSync(this.tokenPath);
  }

  targetRange() {
    return this.range.includes("!") ? this.range : `${this.sheetName}!${this.range}`;
  }

  async getAccessToken() {
    this.loadTokens();
    if (!this.tokens) {
      throw new Error("Chưa kết nối Google. Mở nút Kết nối Google trên website trước.");
    }

    if (this.tokens.access_token && Date.now() < Number(this.tokens.expiresAt || 0) - 60_000) {
      return this.tokens.access_token;
    }

    if (!this.tokens.refresh_token) {
      throw new Error("Phiên Google đã hết hạn. Hãy kết nối Google lại trên website.");
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
        refresh_token: this.tokens.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) {
      throw new Error(`Google OAuth refresh HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const data = await response.json();
    this.saveTokens({
      ...data,
      refresh_token: data.refresh_token || this.tokens.refresh_token,
      accountEmail: this.tokens.accountEmail || "",
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    });
    return this.tokens.access_token;
  }

  async readValues(range, token) {
    const endpoint = `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Google Sheets HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const data = await response.json();
    return Array.isArray(data.values) ? data.values : [];
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
    if (!this.isConfigured()) {
      throw new Error("Google Sheets OAuth chưa được cấu hình");
    }

    const token = await this.getAccessToken();
    const taskId = await this.nextTaskId(token);
    const endpoint = `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(this.targetRange())}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: buildTaskRow({ ...task, id: taskId }) }),
    });
    if (!response.ok) {
      throw new Error(`Google Sheets HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const data = await response.json();
    const updatedRange = data.updates?.updatedRange || "";
    const rowMatch = updatedRange.match(/!(?:[A-Z]+)(\d+)/i);
    return {
      taskId,
      updatedRange,
      rowNumber: rowMatch ? Number(rowMatch[1]) : null,
    };
  }

  async updateTask(rowNumber, task) {
    const operation = this.appendQueue.then(() => this._updateTask(rowNumber, task));
    this.appendQueue = operation.catch(() => {});
    return operation;
  }

  async _updateTask(rowNumber, task) {
    if (!this.isConfigured()) {
      throw new Error("Google Sheets OAuth chưa được cấu hình");
    }
    if (!Number.isInteger(Number(rowNumber)) || Number(rowNumber) < 2) {
      throw new Error("Không xác định được dòng task cần update trong Google Sheet");
    }

    const token = await this.getAccessToken();
    const row = Number(rowNumber);
    const range = `${this.sheetName}!A${row}:H${row}`;
    const endpoint = `${SHEETS_API}/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        majorDimension: "ROWS",
        values: buildTaskRow({ ...task, id: task.id ?? task.taskId }),
      }),
    });
    if (!response.ok) {
      throw new Error(`Google Sheets HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const data = await response.json();
    return {
      taskId: task.id ?? task.taskId ?? null,
      updatedRange: data.updatedRange || range,
      rowNumber: row,
    };
  }
}

export { GoogleSheetsClient, buildTaskRow, columnLetter, normalizeSpreadsheetId };
