import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { GoogleServiceAccountTokenProvider } from "../src/google-service-account.js";

function makeProvider({ fetchImpl, now = () => 1_800_000_000_000 } = {}) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const fsImpl = {
    readFileSync: () => JSON.stringify({
      client_email: "sheets-bot@example.com",
      private_key: privateKey,
      token_uri: "https://oauth.example.test/token",
    }),
  };
  return {
    pair,
    provider: new GoogleServiceAccountTokenProvider({
      keyPath: "fake-service-account.json",
      fsImpl,
      fetchImpl,
      now,
    }),
  };
}

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data };
}

test("service account JWT has the expected claims and verifies with its public key", async () => {
  let request;
  const { pair, provider } = makeProvider({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ access_token: "access-token", expires_in: 3600 });
    },
  });
  assert.equal(await provider.getAccessToken(), "access-token");
  assert.equal(request.url, "https://oauth.example.test/token");
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claims, signature] = form.get("assertion").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString("utf8")), {
    iss: "sheets-bot@example.com",
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth.example.test/token",
    iat: 1_800_000_000,
    exp: 1_800_003_600,
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${claims}`);
  verifier.end();
  assert.equal(verifier.verify(pair.publicKey, Buffer.from(signature, "base64url")), true);
});

test("service account token is cached and concurrent refreshes share one request", async () => {
  let calls = 0;
  const { provider } = makeProvider({
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({ access_token: "cached-token", expires_in: 3600 });
    },
  });
  const tokens = await Promise.all([provider.getAccessToken(), provider.getAccessToken(), provider.getAccessToken()]);
  assert.deepEqual(tokens, ["cached-token", "cached-token", "cached-token"]);
  assert.equal(calls, 1);
  assert.equal(await provider.getAccessToken(), "cached-token");
  assert.equal(calls, 1);
});

test("missing or invalid service account keys are not configured", async () => {
  const provider = new GoogleServiceAccountTokenProvider({
    keyPath: "missing.json",
    fsImpl: { readFileSync: () => "not-json" },
    fetchImpl: async () => assert.fail("invalid configuration must not fetch"),
  });
  assert.equal(provider.isConfigured(), false);
  assert.equal(provider.getAccountEmail(), "");
  await assert.rejects(provider.getAccessToken(), /chưa được cấu hình/i);
});
