import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleLogin } from "../src/google-login.js";
import { createSessionManager, getCookieValue } from "../src/session.js";

function makeSetup({
  now = () => 1_800_000_000_000,
  user = { email: "owner@example.com", email_verified: true },
  allowedRole = "owner",
} = {}) {
  const calls = [];
  const sessionManager = createSessionManager({ secret: "test-session-secret", secure: true, now });
  const login = createGoogleLogin({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://app.example.com/auth/google/callback",
    allowlist: { getRole: () => allowedRole },
    sessionManager,
    now,
    randomBytesImpl: (size) => Buffer.alloc(size, 3),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "private-access-token" }) };
      }
      if (String(url).includes("userinfo")) return { ok: true, status: 200, json: async () => user };
      throw new Error("Unexpected URL");
    },
  });
  const start = login.startLogin();
  const loginUrl = new URL(start.location);
  const state = loginUrl.searchParams.get("state");
  const stateCookie = getCookieValue(start.cookies[0], "alpha_oauth_state");
  const callbackUrl = (params = {}) => {
    const callback = new URL("https://app.example.com/auth/google/callback");
    callback.searchParams.set("state", state);
    for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
    return callback;
  };
  return { calls, login, loginUrl, state, stateCookie, callbackUrl, sessionManager };
}

test("login creates a random state cookie and one-time authorization state", async () => {
  const setup = makeSetup();
  assert.equal(Buffer.from(setup.state, "hex").length, 32);
  assert.equal(setup.loginUrl.searchParams.get("scope"), "openid email");
  assert.equal(setup.loginUrl.searchParams.get("response_type"), "code");
  assert.equal(setup.loginUrl.searchParams.get("prompt"), null);
  assert.equal(setup.loginUrl.searchParams.get("access_type"), null);
  assert.match(setup.loginUrl.origin, /accounts\.google\.com/);
  assert.match(setup.loginUrl.searchParams.get("redirect_uri"), /auth\/google\/callback$/);
  assert.match(setup.loginUrl.searchParams.get("state"), new RegExp(`^${setup.state}$`));
  assert.equal(typeof setup.login.states.get(setup.state), "number");

  const result = await setup.login.handleCallback({
    url: setup.callbackUrl({ code: "authorization-code" }),
    cookieHeader: `alpha_oauth_state=${setup.stateCookie}`,
  });
  assert.equal(result.location, "/");
  const repeated = await setup.login.handleCallback({
    url: setup.callbackUrl({ code: "authorization-code" }),
    cookieHeader: `alpha_oauth_state=${setup.stateCookie}`,
  });
  assert.equal(repeated.location, "/login?error=state");
  assert.equal(setup.calls.length, 2);
});

test("login state expires after ten minutes and state-cookie mismatch is rejected", async () => {
  let now = 1_800_000_000_000;
  const expired = makeSetup({ now: () => now });
  now += 10 * 60 * 1000 + 1;
  const expiredResult = await expired.login.handleCallback({
    url: expired.callbackUrl({ code: "authorization-code" }),
    cookieHeader: `alpha_oauth_state=${expired.stateCookie}`,
  });
  assert.equal(expiredResult.location, "/login?error=state");
  assert.equal(expired.calls.length, 0);

  const mismatch = makeSetup();
  const mismatchResult = await mismatch.login.handleCallback({
    url: mismatch.callbackUrl({ code: "authorization-code" }),
    cookieHeader: "alpha_oauth_state=another-state",
  });
  assert.equal(mismatchResult.location, "/login?error=state");
  assert.equal(mismatch.calls.length, 0);
});

test("unverified email is denied without exposing it in the redirect", async () => {
  const setup = makeSetup({ user: { email: "private@example.com", email_verified: false } });
  const result = await setup.login.handleCallback({
    url: setup.callbackUrl({ code: "authorization-code" }),
    cookieHeader: `alpha_oauth_state=${setup.stateCookie}`,
  });
  assert.equal(result.location, "/login?error=unverified");
  assert.equal(result.location.includes("private@example.com"), false);
  assert.equal(result.location.includes("private-access-token"), false);
});

test("email outside the allowlist is forbidden and never appears in the URL", async () => {
  const setup = makeSetup({ user: { email: "outside@example.com", email_verified: true }, allowedRole: null });
  const result = await setup.login.handleCallback({
    url: setup.callbackUrl({ code: "authorization-code" }),
    cookieHeader: `alpha_oauth_state=${setup.stateCookie}`,
  });
  assert.equal(result.location, "/login?error=forbidden");
  assert.equal(result.location.includes("outside@example.com"), false);
  assert.equal(result.location.includes("private-access-token"), false);
});

test("verified allowlisted login sets a signed session and clears the state cookie", async () => {
  const setup = makeSetup();
  const result = await setup.login.handleCallback({
    url: setup.callbackUrl({ code: "authorization-code" }),
    cookieHeader: `alpha_oauth_state=${setup.stateCookie}`,
  });
  assert.equal(result.location, "/");
  assert.equal(result.location.includes("owner@example.com"), false);
  assert.equal(result.location.includes("private-access-token"), false);
  assert.equal(result.cookies.length, 2);
  assert.match(result.cookies[0], /^alpha_oauth_state=;.*Max-Age=0/);
  const sessionCookie = getCookieValue(result.cookies[1], "alpha_session");
  assert.equal(setup.sessionManager.verifyCookie(sessionCookie).email, "owner@example.com");
  assert.match(result.cookies[1], /; Secure$/);
  assert.equal(new URL(setup.calls[0].url).searchParams.has("client_secret"), false);
  assert.equal(setup.calls[1].options.headers.Authorization, "Bearer private-access-token");
});
