import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SESSION_COOKIE = "alpha_session";
const OAUTH_STATE_COOKIE = "alpha_oauth_state";

function getCookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function loadOrCreateSessionSecret({ envSecret = "", secretPath, fsImpl = { mkdirSync, readFileSync, writeFileSync }, randomBytesImpl = randomBytes } = {}) {
  if (envSecret) return Buffer.from(envSecret, "utf8");
  try {
    const existing = fsImpl.readFileSync(secretPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(existing)) throw new Error("Invalid persisted session secret");
    return Buffer.from(existing, "hex");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const generated = randomBytesImpl(32).toString("hex");
  fsImpl.mkdirSync(dirname(secretPath), { recursive: true });
  try {
    fsImpl.writeFileSync(secretPath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return Buffer.from(generated, "hex");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = fsImpl.readFileSync(secretPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(existing)) throw new Error("Invalid persisted session secret");
    return Buffer.from(existing, "hex");
  }
}

function createSessionManager({ secret, ttlDays = 30, secure = false, now = Date.now } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ""), "utf8");
  const ttlSeconds = Math.floor(Number(ttlDays) * 24 * 60 * 60);
  if (!key.length || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Session configuration is invalid");
  }

  function sign(payloadBase64) {
    return createHmac("sha256", key).update(payloadBase64).digest("base64url");
  }

  function createSession(email) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail) throw new Error("Session email is required");
    const iat = Math.floor(now() / 1000);
    const payload = { email: normalizedEmail, iat, exp: iat + ttlSeconds };
    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return { value: `${payloadBase64}.${sign(payloadBase64)}`, payload };
  }

  function verifyCookie(value) {
    const parts = String(value || "").split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    let received;
    try {
      received = Buffer.from(parts[1], "base64url");
    } catch {
      return null;
    }
    const expected = Buffer.from(sign(parts[0]), "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      const currentTime = Math.floor(now() / 1000);
      if (
        !payload ||
        typeof payload.email !== "string" ||
        !payload.email.trim() ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp) ||
        payload.iat > currentTime + 60 ||
        payload.exp <= currentTime ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > ttlSeconds
      ) return null;
      return { email: payload.email.trim().toLowerCase(), iat: payload.iat, exp: payload.exp };
    } catch {
      return null;
    }
  }

  function isValidSession(session) {
    const currentTime = Math.floor(now() / 1000);
    return Boolean(
      session &&
        typeof session.email === "string" &&
        session.email.trim() &&
        Number.isInteger(session.iat) &&
        Number.isInteger(session.exp) &&
        session.iat <= currentTime + 60 &&
        session.exp > currentTime &&
        session.exp > session.iat &&
        session.exp - session.iat <= ttlSeconds,
    );
  }

  function cookieHeader(session) {
    if (!isValidSession(session)) throw new Error("Cannot issue an invalid session cookie");
    const payloadBase64 = Buffer.from(JSON.stringify({
      email: session.email.trim().toLowerCase(),
      iat: session.iat,
      exp: session.exp,
    })).toString("base64url");
    const value = `${payloadBase64}.${sign(payloadBase64)}`;
    return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}${secure ? "; Secure" : ""}`;
  }

  function renew(session) {
    if (!isValidSession(session)) return null;
    const currentTime = Math.floor(now() / 1000);
    return session.exp - currentTime < ttlSeconds / 2 ? createSession(session.email) : null;
  }

  function clearCookie() {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
  }

  return { createSession, verifyCookie, cookieHeader, clearCookie, renew, isValidSession, ttlSeconds, secure };
}

export {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  createSessionManager,
  getCookieValue,
  loadOrCreateSessionSecret,
};
