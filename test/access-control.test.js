import test from "node:test";
import assert from "node:assert/strict";
import { authorizeRequest, isLoopbackHost, isSameOrigin } from "../src/access-control.js";

test("public webhook aliases and login/liveness routes are available without a role", () => {
  for (const pathname of ["/callback", "/seatalk/callback", "/webhook/seatalk"]) {
    assert.equal(authorizeRequest({ method: "POST", pathname }), "allow");
    assert.equal(authorizeRequest({ method: "POST", pathname, role: "viewer" }), "allow");
    assert.equal(authorizeRequest({ method: "POST", pathname, role: "owner" }), "allow");
  }
  for (const pathname of ["/healthz", "/login", "/login.html", "/auth/login", "/auth/google/callback"]) {
    assert.equal(authorizeRequest({ method: "GET", pathname }), "allow");
  }
});

test("viewer routes allow both roles and deny unauthenticated access", () => {
  const routes = [
    ["GET", "/api/me"],
    ["GET", "/api/messages"],
    ["GET", "/api/stream"],
    ["GET", "/api/health"],
    ["GET", "/api/google/status"],
    ["POST", "/auth/logout"],
  ];
  for (const [method, pathname] of routes) {
    assert.equal(authorizeRequest({ method, pathname, role: "viewer" }), "allow");
    assert.equal(authorizeRequest({ method, pathname, role: "owner" }), "allow");
    assert.equal(authorizeRequest({ method, pathname }), "unauthorized");
  }
});

test("owner-only routes return forbidden to viewers and allow owners", () => {
  for (const [method, pathname] of [["DELETE", "/api/messages"], ["POST", "/api/test-message"]]) {
    assert.equal(authorizeRequest({ method, pathname, role: "owner" }), "allow");
    assert.equal(authorizeRequest({ method, pathname, role: "viewer" }), "forbidden");
    assert.equal(authorizeRequest({ method, pathname }), "unauthorized");
  }
});

test("unauthenticated HTML navigation redirects while API requests return 401", () => {
  assert.equal(authorizeRequest({ method: "GET", pathname: "/", accept: "text/html" }), "redirect-login");
  assert.equal(authorizeRequest({ method: "GET", pathname: "/index.html", accept: "text/html" }), "redirect-login");
  assert.equal(authorizeRequest({ method: "GET", pathname: "/api/messages", accept: "text/html" }), "unauthorized");
  assert.equal(authorizeRequest({ method: "GET", pathname: "/api/messages" }), "unauthorized");
});

test("static files require a role; unknown API routes are consistently denied", () => {
  assert.equal(authorizeRequest({ method: "GET", pathname: "/styles.css", role: "viewer" }), "allow");
  assert.equal(authorizeRequest({ method: "GET", pathname: "/public/missing.js", role: "owner" }), "allow");
  assert.equal(authorizeRequest({ method: "GET", pathname: "/api/missing", role: "owner" }), "forbidden");
  assert.equal(authorizeRequest({ method: "POST", pathname: "/not-a-route", role: "owner" }), "forbidden");
  assert.equal(authorizeRequest({ method: "GET", pathname: "/api/missing" }), "unauthorized");
});

test("AUTH_DISABLED treats protected routes as owner and loopback detection is explicit", () => {
  assert.equal(authorizeRequest({ method: "DELETE", pathname: "/api/messages", authDisabled: true }), "allow");
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});

test("same-origin check compares the Origin host to the Host header", () => {
  assert.equal(isSameOrigin("http://localhost:3030", "localhost:3030"), true);
  assert.equal(isSameOrigin("https://app.example.com", "app.example.com"), true);
  assert.equal(isSameOrigin("https://evil.example", "app.example.com"), false);
  assert.equal(isSameOrigin("not-an-origin", "app.example.com"), false);
  assert.equal(isSameOrigin("", "app.example.com"), true);
});
