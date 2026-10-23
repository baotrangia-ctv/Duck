import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getCookieValue, OAUTH_STATE_COOKIE } from "./session.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const STATE_TTL_MS = 10 * 60 * 1000;

function canonicalLoginRedirect(requestHost, redirectUri) {
  try {
    const origin = new URL(redirectUri);
    return requestHost === origin.host ? null : `${origin.origin}/auth/login`;
  } catch {
    return null;
  }
}

function createGoogleLogin({
  clientId = "", clientSecret = "", redirectUri = "", stateSecret = "",
  allowlist, sessionManager, fetchImpl = (...args) => fetch(...args),
  now = Date.now, randomBytesImpl = randomBytes,
} = {}) {
  const secure = String(redirectUri).startsWith("https://");

  function stateCookie(value, maxAge) {
    const expires = maxAge === 0 ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "";
    return `${OAUTH_STATE_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=${maxAge}${expires}${secure ? "; Secure" : ""}`;
  }

  function signature(value) {
    return createHmac("sha256", stateSecret).update(value).digest("hex");
  }

  function validState(state) {
    const parts = state.split(".");
    if (parts.length !== 3 || !/^[a-f0-9]{64}$/.test(parts[0]) || !/^\d{13}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return false;
    const expiresAt = Number(parts[1]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + STATE_TTL_MS) return false;
    return timingSafeEqual(Buffer.from(parts[2], "hex"), Buffer.from(signature(`${parts[0]}.${parts[1]}`), "hex"));
  }

  function failure(code, detail = "") {
    console.error(`Google login: ${code}${detail ? ` ${detail}` : ""}`);
    return { location: `/login?error=${code}`, cookies: [stateCookie("", 0)] };
  }

  function startLogin() {
    const missing = [
      !clientId && "GOOGLE_OAUTH_CLIENT_ID", !clientSecret && "GOOGLE_OAUTH_CLIENT_SECRET",
      !redirectUri && "GOOGLE_OAUTH_REDIRECT_URI", !stateSecret && "AUTH_SESSION_SECRET",
    ].filter(Boolean);
    if (missing.length) return failure("config", `missing ${missing.join(", ")}`);
    const base = `${randomBytesImpl(32).toString("hex")}.${now() + STATE_TTL_MS}`;
    const state = `${base}.${signature(base)}`;
    const params = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      scope: "openid email", prompt: "select_account", state,
    });
    return { location: `${GOOGLE_AUTH_URL}?${params}`, cookies: [stateCookie(state, 600)] };
  }

  async function providerDetail(response, sensitive = []) {
    let data;
    try { data = await response.json(); } catch { return `HTTP ${response.status}`; }
    const fields = ["error", "error_description"].filter((key) => typeof data?.[key] === "string")
      .map((key) => {
        let value = data[key].slice(0, 200);
        for (const secret of sensitive) {
          if (secret) value = value.replaceAll(secret, "[redacted]");
        }
        return `${key}=${JSON.stringify(value)}`;
      });
    return [`HTTP ${response.status}`, ...fields].join(" ");
  }

  async function handleCallback({ url, cookieHeader = "" } = {}) {
    const state = url?.searchParams?.get("state") || "";
    if (!validState(state)) return failure("state");
    if (getCookieValue(cookieHeader, OAUTH_STATE_COOKIE) !== state) return failure("cookie");
    const googleError = url.searchParams.get("error");
    if (googleError) return failure("cancelled", /^[a-z_]{1,100}$/.test(googleError) ? `error=${googleError}` : "provider error");
    const code = url.searchParams.get("code") || "";
    if (!code) return failure("token", "missing authorization code");

    let tokenResponse;
    try {
      tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: "authorization_code" }),
      });
    } catch { return failure("token", "fetch failed"); }
    if (!tokenResponse.ok) return failure("token", await providerDetail(tokenResponse, [code, clientSecret, state]));
    let tokenData;
    try { tokenData = await tokenResponse.json(); } catch { return failure("token", "invalid response JSON"); }
    if (typeof tokenData?.access_token !== "string" || !tokenData.access_token) return failure("token", "missing access_token");

    let userResponse;
    try {
      userResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
    } catch { return failure("userinfo", "fetch failed"); }
    if (!userResponse.ok) return failure("userinfo", await providerDetail(userResponse, [code, clientSecret, state, tokenData.access_token]));
    let user;
    try { user = await userResponse.json(); } catch { return failure("userinfo", "invalid response JSON"); }
    if ((user?.email_verified !== true && user?.email_verified !== "true") || typeof user?.email !== "string" || !user.email.trim()) return failure("unverified");
    const email = user.email.trim().toLowerCase();
    if (!allowlist?.getRole?.(email)) return failure("forbidden", `email=${email}`);
    const session = sessionManager.createSession(email);
    return { location: "/", cookies: [stateCookie("", 0), sessionManager.cookieHeader(session.payload)] };
  }

  return { startLogin, handleCallback };
}

export { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, STATE_TTL_MS, canonicalLoginRedirect, createGoogleLogin };
