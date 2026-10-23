import test from "node:test";
import assert from "node:assert/strict";
import { describeRedirectUri } from "../src/oauth-redirect.js";

test("default localhost redirect URI is valid when its port matches PORT", () => {
  assert.deepEqual(describeRedirectUri({
    redirectUri: "http://localhost:3030/auth/google/callback",
    port: 3030,
    host: "0.0.0.0",
    explicit: false,
  }), { ok: true, warnings: [] });
});

test("redirect URI warns when it is not an absolute HTTP URL", () => {
  const result = describeRedirectUri({
    redirectUri: "ftp://example.com/auth/google/callback",
    port: 3030,
    host: "127.0.0.1",
    explicit: true,
  });

  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((warning) => warning.includes("URL tuyệt đối")));
});

test("redirect URI warns when its path differs from the callback route", () => {
  const result = describeRedirectUri({
    redirectUri: "https://example.com/oauth/callback",
    port: 3030,
    host: "0.0.0.0",
    explicit: true,
  });

  assert.ok(result.warnings.some((warning) => warning.includes("/auth/google/callback")));
});

test("redirect URI warns about a trailing slash and surrounding whitespace", () => {
  const trailingSlash = describeRedirectUri({
    redirectUri: "https://example.com/auth/google/callback/",
    port: 3030,
    host: "0.0.0.0",
    explicit: true,
  });
  const whitespace = describeRedirectUri({
    redirectUri: " https://example.com/auth/google/callback ",
    port: 3030,
    host: "0.0.0.0",
    explicit: true,
  });

  assert.ok(trailingSlash.warnings.some((warning) => warning.includes("gạch chéo cuối")));
  assert.ok(whitespace.warnings.some((warning) => warning.includes("khoảng trắng")));
});

test("loopback redirect URI warns when its port differs from PORT", () => {
  const result = describeRedirectUri({
    redirectUri: "http://localhost:3031/auth/google/callback",
    port: 3030,
    host: "127.0.0.1",
    explicit: true,
  });

  assert.ok(result.warnings.some((warning) => warning.includes("PORT=3030")));
});

test("HTTP redirect URI warns for non-loopback hosts", () => {
  const result = describeRedirectUri({
    redirectUri: "http://app.example.com/auth/google/callback",
    port: 3030,
    host: "0.0.0.0",
    explicit: true,
  });

  assert.ok(result.warnings.some((warning) => warning.includes("https://")));
});

test("127.0.0.1 redirect URI explains it must be registered separately", () => {
  const result = describeRedirectUri({
    redirectUri: "http://127.0.0.1:3030/auth/google/callback",
    port: 3030,
    host: "127.0.0.1",
    explicit: true,
  });

  assert.ok(result.warnings.some((warning) => warning.includes("đăng ký riêng")));
  assert.ok(result.warnings.some((warning) => warning.includes("localhost")));
});
