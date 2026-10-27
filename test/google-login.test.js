import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createGoogleLogin, canonicalLoginRedirect } from "../src/google-login.js";
import { createSessionManager, getCookieValue } from "../src/session.js";

function makeSetup({
  now = () => 1_800_000_000_000,
  user = { email: "owner@example.com", email_verified: true },
  allowedRole = "owner",
} = {}) {
  const calls = [];
  const sessionManager = createSessionManager({ secret: "test-session-secret", secure: true, now });
  const login = createGoogleLogin({
    stateSecret: "test-session-secret",
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

test("login creates a signed state cookie and offers account selection", async () => {
  const setup = makeSetup();
  assert.equal(setup.state.split(".").length, 3);
  assert.equal(Buffer.from(setup.state.split(".")[0], "hex").length, 32);
  assert.equal(setup.loginUrl.searchParams.get("scope"), "openid email");
  assert.equal(setup.loginUrl.searchParams.get("response_type"), "code");
  assert.equal(setup.loginUrl.searchParams.get("prompt"), "select_account");
  assert.equal(setup.loginUrl.searchParams.get("access_type"), null);
  assert.match(setup.loginUrl.origin, /accounts\.google\.com/);
  assert.match(setup.loginUrl.searchParams.get("redirect_uri"), /auth\/google\/callback$/);
  assert.match(setup.loginUrl.searchParams.get("state"), new RegExp(`^${setup.state}$`));
  assert.match(setup.login.startLogin().cookies[0], /Path=\/auth;/);

  const result = await setup.login.handleCallback({
    url: setup.callbackUrl({ code: "authorization-code" }),
    cookieHeader: `alpha_oauth_state=${setup.stateCookie}`,
  });
  assert.equal(result.location, "/");
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
  assert.equal(mismatchResult.location, "/login?error=cookie");
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

test("signed state survives a new login instance and rejects another secret", async () => {
  const setup = makeSetup();
  const options = {
    clientId: "client-id", clientSecret: "client-secret",
    redirectUri: "https://app.example.com/auth/google/callback",
    allowlist: { getRole: () => "owner" }, sessionManager: setup.sessionManager,
    now: () => 1_800_000_000_000,
    fetchImpl: async (url) => ({ ok: true, json: async () =>
      String(url).includes("token") ? { access_token: "private-access-token" } :
        { email: "owner@example.com", email_verified: true } }),
  };
  const callback = { url: setup.callbackUrl({ code: "private-code" }), cookieHeader: `alpha_oauth_state=${setup.state}` };
  assert.equal((await createGoogleLogin({ ...options, stateSecret: "test-session-secret" }).handleCallback(callback)).location, "/");
  assert.equal((await createGoogleLogin({ ...options, stateSecret: "other-secret" }).handleCallback(callback)).location, "/login?error=state");
});

test("canonical login redirect compares host and port", () => {
  const uri = "http://localhost:3030/auth/google/callback";
  assert.equal(canonicalLoginRedirect("127.0.0.1:3030", uri), "http://localhost:3030/auth/login");
  assert.equal(canonicalLoginRedirect("localhost:3031", uri), "http://localhost:3030/auth/login");
  assert.equal(canonicalLoginRedirect("localhost:3030", uri), null);
});

test("public login rejects loopback callbacks while preserving configured public origins", () => {
  const publicHost = "craftland-duck.demo.ved.com.vn";
  for (const loopback of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(canonicalLoginRedirect(publicHost, `http://${loopback}:3000/auth/google/callback`), "/login?error=config");
  }
  const uri = `https://${publicHost}/auth/google/callback`;
  assert.equal(canonicalLoginRedirect(publicHost, uri), null);
  assert.equal(canonicalLoginRedirect("alias.example.com", uri), `https://${publicHost}/auth/login`);
  assert.equal(canonicalLoginRedirect("localhost.evil.example", "http://localhost:3000/auth/google/callback"), "/login?error=config");
  assert.equal(canonicalLoginRedirect("[::1]:3001", "http://localhost:3000/auth/google/callback"), "http://localhost:3000/auth/login");
});

test("login messages cover known codes and reject unknown query text", () => {
  const page = readFileSync(new URL("../public/login.html", import.meta.url), "utf8");
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const render = (search) => {
    const elements = { "#loginError": { textContent: "" }, "#loginErrorCode": { textContent: "" } };
    const redirects = [];
    runInNewContext(script, {
      URLSearchParams,
      Object,
      window: { location: { search, replace: (url) => redirects.push(url) } },
      document: { querySelector: (selector) => elements[selector] },
    });
    return { elements, redirects };
  };
  for (const code of ["config", "cancelled", "state", "cookie", "token", "userinfo", "unverified", "forbidden"]) {
    const result = render(`?error=${code}`);
    assert.ok(result.elements["#loginError"].textContent);
    assert.equal(result.elements["#loginErrorCode"].textContent, `Mã lỗi: ${code}`);
    assert.deepEqual(result.redirects, []);
  }
  const unknown = render("?error=%3Cscript%3E");
  assert.equal(unknown.elements["#loginError"].textContent, "Đăng nhập không thành công. Vui lòng thử lại.");
  assert.equal(unknown.elements["#loginErrorCode"].textContent, "");
  assert.deepEqual(render("").redirects, ["/auth/login"]);
  assert.equal(render("?loggedout=1").elements["#loginError"].textContent, "Bạn đã đăng xuất.");
  assert.deepEqual(render("?loggedout=1").redirects, []);
  assert.match(page, /<noscript><a href="\/auth\/login">/);
});

test("config and callback failures use precise codes with safe log lines", async () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  try {
    const setup = makeSetup();
    const base = {
      clientId: "client-id", clientSecret: "private-client-secret",
      redirectUri: "https://app.example.com/auth/google/callback",
      stateSecret: "test-session-secret", sessionManager: setup.sessionManager,
      allowlist: { getRole: () => null }, now: () => 1_800_000_000_000,
    };
    const callback = (params = {}, cookie = setup.state) => ({
      url: setup.callbackUrl({ code: "private-code", ...params }),
      cookieHeader: cookie == null ? "" : `alpha_oauth_state=${cookie}`,
    });
    const cases = [
      ["config", createGoogleLogin({ ...base, clientId: "" }), null],
      ["state", createGoogleLogin(base), callback({ state: "bad-state" })],
      ["cookie", createGoogleLogin(base), callback({}, null)],
      ["cancelled", createGoogleLogin(base), callback({ error: "access_denied" })],
      ["token", createGoogleLogin({ ...base, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "private-code rejected" }) }) }), callback()],
      ["userinfo", createGoogleLogin({ ...base, fetchImpl: async (url) => String(url).includes("token") ? ({ ok: true, json: async () => ({ access_token: "private-access-token" }) }) : ({ ok: false, status: 503, json: async () => ({ error: "unavailable", error_description: "private-access-token rejected" }) }) }), callback()],
      ["unverified", createGoogleLogin({ ...base, fetchImpl: async (url) => ({ ok: true, json: async () => String(url).includes("token") ? ({ access_token: "private-access-token" }) : ({ email: "owner@example.com", email_verified: false }) }) }), callback()],
      ["forbidden", createGoogleLogin({ ...base, fetchImpl: async (url) => ({ ok: true, json: async () => String(url).includes("token") ? ({ access_token: "private-access-token" }) : ({ email: "outside@example.com", email_verified: true }) }) }), callback()],
    ];
    for (const [code, login, request] of cases) {
      const result = request ? await login.handleCallback(request) : login.startLogin();
      assert.equal(result.location, `/login?error=${code}`);
      assert.match(logs.at(-1), new RegExp(`^Google login: ${code}\\b`));
    }
    assert.match(logs.join("\n"), /invalid_grant/);
    assert.match(logs.join("\n"), /outside@example.com/);
    assert.doesNotMatch(logs.join("\n"), /private-code|private-access-token|private-client-secret|bad-state/);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test("string email_verified is accepted", async () => {
  const setup = makeSetup({ user: { email: "owner@example.com", email_verified: "true" } });
  assert.equal((await setup.login.handleCallback({ url: setup.callbackUrl({ code: "private-code" }), cookieHeader: `alpha_oauth_state=${setup.state}` })).location, "/");
});

test("token and userinfo transport and response failures stay distinct", async () => {
  const setup = makeSetup();
  const base = {
    clientId: "client-id", clientSecret: "private-client-secret",
    redirectUri: "https://app.example.com/auth/google/callback",
    stateSecret: "test-session-secret", sessionManager: setup.sessionManager,
    now: () => 1_800_000_000_000,
  };
  const callback = { url: setup.callbackUrl({ code: "private-code" }), cookieHeader: `alpha_oauth_state=${setup.state}` };
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const tokenFailures = [
      async () => { throw new Error("private-client-secret"); },
      async () => ({ ok: true, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => { throw new Error("private-code"); } }),
    ];
    for (const fetchImpl of tokenFailures) {
      assert.equal((await createGoogleLogin({ ...base, fetchImpl }).handleCallback(callback)).location, "/login?error=token");
    }
    const userFailures = [
      async () => { throw new Error("private-access-token"); },
      async () => ({ ok: true, json: async () => { throw new Error("private-access-token"); } }),
    ];
    for (const userFetch of userFailures) {
      const fetchImpl = async (url) => String(url).includes("token")
        ? { ok: true, json: async () => ({ access_token: "private-access-token" }) }
        : userFetch();
      assert.equal((await createGoogleLogin({ ...base, fetchImpl }).handleCallback(callback)).location, "/login?error=userinfo");
    }
    assert.equal(logs.length, 5);
    assert.doesNotMatch(logs.join("\n"), /private-client-secret|private-code|private-access-token/);
  } finally {
    console.error = originalError;
  }
});
