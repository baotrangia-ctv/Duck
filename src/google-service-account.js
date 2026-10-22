import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

class GoogleServiceAccountTokenProvider {
  constructor({ keyPath = "", fetchImpl = (...args) => fetch(...args), now = Date.now, fsImpl = { readFileSync } } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.key = null;
    this.accessToken = "";
    this.expiresAt = 0;
    this.pendingRefresh = null;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(keyPath, "utf8"));
      if (typeof parsed.client_email !== "string" || !parsed.client_email.trim() || typeof parsed.private_key !== "string") return;
      const tokenUri = parsed.token_uri || DEFAULT_TOKEN_URI;
      const tokenUrl = new URL(tokenUri);
      if (tokenUrl.protocol !== "https:") return;
      this.key = {
        clientEmail: parsed.client_email.trim(),
        privateKey: createPrivateKey(parsed.private_key),
        tokenUri,
      };
    } catch {
      this.key = null;
    }
  }

  isConfigured() {
    return Boolean(this.key);
  }

  getAccountEmail() {
    return this.key?.clientEmail || "";
  }

  async getAccessToken() {
    if (!this.key) throw new Error("Google service account chưa được cấu hình.");
    if (this.accessToken && this.now() < this.expiresAt - 60_000) return this.accessToken;
    if (this.pendingRefresh) return this.pendingRefresh;
    this.pendingRefresh = this.refreshAccessToken();
    try {
      return await this.pendingRefresh;
    } finally {
      this.pendingRefresh = null;
    }
  }

  async refreshAccessToken() {
    const issuedAt = Math.floor(this.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(JSON.stringify({
      iss: this.key.clientEmail,
      scope: SHEETS_SCOPE,
      aud: this.key.tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }));
    const unsigned = `${header}.${claims}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    const assertion = `${unsigned}.${signer.sign(this.key.privateKey).toString("base64url")}`;
    const response = await this.fetchImpl(this.key.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) throw new Error(`Google service account token HTTP ${response.status}`);
    const data = await response.json();
    if (typeof data.access_token !== "string" || !data.access_token) {
      throw new Error("Google service account token response is invalid");
    }
    this.accessToken = data.access_token;
    this.expiresAt = this.now() + Number(data.expires_in || 3600) * 1000;
    return this.accessToken;
  }
}

export { DEFAULT_TOKEN_URI, GoogleServiceAccountTokenProvider, SHEETS_SCOPE };
