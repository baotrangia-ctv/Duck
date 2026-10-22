import test from "node:test";
import assert from "node:assert/strict";
import { createSessionManager, getCookieValue, loadOrCreateSessionSecret } from "../src/session.js";

test("session cookie signs and verifies an email without storing a role", () => {
  const manager = createSessionManager({ secret: "test-session-secret", now: () => 1_800_000_000_000 });
  const session = manager.createSession(" Owner@Example.com ");
  const cookie = manager.cookieHeader(session.payload);
  const value = getCookieValue(cookie, "alpha_session");
  assert.deepEqual(manager.verifyCookie(value), {
    email: "owner@example.com",
    iat: 1_800_000_000,
    exp: 1_802_592_000,
  });
  const payload = JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(payload).sort(), ["email", "exp", "iat"]);
});

test("tampered payloads and signatures are rejected", () => {
  const manager = createSessionManager({ secret: "test-session-secret", now: () => 1_800_000_000_000 });
  const cookieValue = manager.createSession("owner@example.com").value;
  const [payload, signature] = cookieValue.split(".");
  assert.equal(manager.verifyCookie(`${payload}x.${signature}`), null);
  const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.equal(manager.verifyCookie(`${payload}.${changedSignature}`), null);
  assert.equal(manager.verifyCookie("not-a-cookie"), null);
});

test("expired sessions are rejected", () => {
  let now = 1_800_000_000_000;
  const manager = createSessionManager({ secret: "test-session-secret", ttlDays: 1, now: () => now });
  const session = manager.createSession("owner@example.com");
  now += 24 * 60 * 60 * 1000;
  assert.equal(manager.verifyCookie(session.value), null);
});

test("sliding sessions renew only when less than half the lifetime remains", () => {
  let now = 1_800_000_000_000;
  const manager = createSessionManager({ secret: "test-session-secret", ttlDays: 2, now: () => now });
  const session = manager.createSession("owner@example.com");
  assert.equal(manager.renew(session.payload), null);
  now += 25 * 60 * 60 * 1000;
  const renewed = manager.renew(session.payload);
  assert.ok(renewed);
  assert.equal(renewed.payload.exp - renewed.payload.iat, 2 * 24 * 60 * 60);
});

test("session cookie flags include Secure only for HTTPS deployments", () => {
  const now = () => 1_800_000_000_000;
  const local = createSessionManager({ secret: "local-secret", secure: false, now });
  const secure = createSessionManager({ secret: "secure-secret", secure: true, now });
  assert.match(local.cookieHeader(local.createSession("a@example.com").payload), /HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000/);
  assert.doesNotMatch(local.cookieHeader(local.createSession("a@example.com").payload), /; Secure/);
  assert.match(secure.cookieHeader(secure.createSession("a@example.com").payload), /; Secure$/);
  assert.match(secure.clearCookie(), /Max-Age=0; Expires=.*; Secure$/);
});

test("generated session secret is persisted with mode 0600", () => {
  const writes = [];
  const secret = loadOrCreateSessionSecret({
    secretPath: "fake/.auth/session-secret",
    randomBytesImpl: () => Buffer.alloc(32, 7),
    fsImpl: {
      readFileSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      mkdirSync: (...args) => writes.push(["mkdir", ...args]),
      writeFileSync: (...args) => writes.push(["write", ...args]),
    },
  });
  assert.equal(secret.length, 32);
  assert.equal(writes[1][3].mode, 0o600);
});
