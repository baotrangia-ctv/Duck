import { randomBytes } from "node:crypto";
import { getCookieValue, OAUTH_STATE_COOKIE } from "./session.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const STATE_TTL_MS = 10 * 60 * 1000;

function createGoogleLogin({
  clientId = "",
  clientSecret = "",
  redirectUri = "",
  allowlist,
  sessionManager,
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  randomBytesImpl = randomBytes,
} = {}) {
  const states = new Map();
  const secure = String(redirectUri).startsWith("https://");

  function stateCookie(value, maxAge) {
    const expires = maxAge === 0 ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "";
    return `${OAUTH_STATE_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/auth/google/callback; Max-Age=${maxAge}${expires}${secure ? "; Secure" : ""}`;
  }

  function removeExpiredStates() {
    const currentTime = now();
    for (const [state, expiresAt] of states) {
      if (expiresAt <= currentTime) states.delete(state);
    }
  }

  function startLogin() {
    if (!clientId || !clientSecret || !redirectUri) return { location: "/login?error=exchange", cookies: [] };
    removeExpiredStates();
    const state = randomBytesImpl(32).toString("hex");
    states.set(state, now() + STATE_TTL_MS);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
    });
    return { location: `${GOOGLE_AUTH_URL}?${params}`, cookies: [stateCookie(state, 600)] };
  }

  function failure(code) {
    return { location: `/login?error=${encodeURIComponent(code)}`, cookies: [stateCookie("", 0)] };
  }

  async function handleCallback({ url, cookieHeader = "" } = {}) {
    removeExpiredStates();
    const state = url?.searchParams?.get("state") || "";
    const expiresAt = states.get(state);
    if (state) states.delete(state);
    const cookieState = getCookieValue(cookieHeader, OAUTH_STATE_COOKIE);
    if (!state || !expiresAt || expiresAt <= now() || cookieState !== state) return failure("state");
    if (url.searchParams.get("error")) return failure("cancelled");
    const code = url.searchParams.get("code") || "";
    if (!code) return failure("exchange");

    try {
      const tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenResponse.ok) return failure("exchange");
      const tokenData = await tokenResponse.json();
      if (typeof tokenData.access_token !== "string" || !tokenData.access_token) return failure("exchange");
      const userResponse = await fetchImpl(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userResponse.ok) return failure("exchange");
      const user = await userResponse.json();
      if (user.email_verified !== true || typeof user.email !== "string" || !user.email.trim()) return failure("unverified");
      const email = user.email.trim().toLowerCase();
      if (!allowlist?.getRole?.(email)) return failure("forbidden");
      const session = sessionManager.createSession(email);
      return {
        location: "/",
        cookies: [stateCookie("", 0), sessionManager.cookieHeader(session.payload)],
      };
    } catch {
      return failure("exchange");
    }
  }

  return { startLogin, handleCallback, states };
}

export { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, STATE_TTL_MS, createGoogleLogin };
