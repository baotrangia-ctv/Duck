import test from "node:test";
import assert from "node:assert/strict";
import { createAllowlist } from "../src/allowlist.js";

function makeFs() {
  let content = null;
  let mtimeMs = 1;
  return {
    fsImpl: {
      statSync: () => {
        if (content === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { mtimeMs };
      },
      readFileSync: () => content,
    },
    setContent(value, nextMtime = mtimeMs + 1) {
      content = value;
      mtimeMs = nextMtime;
    },
  };
}

function quietLogger() {
  const errors = [];
  return { errors, logger: { error: (message) => errors.push(message) } };
}

test("missing allowlist denies everyone and logs once", () => {
  const files = makeFs();
  const { errors, logger } = quietLogger();
  const allowlist = createAllowlist({ path: "allowlist.json", fsImpl: files.fsImpl, logger });
  assert.equal(allowlist.getRole("owner@example.com"), null);
  assert.equal(allowlist.getRole("viewer@example.com"), null);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /example\.com|\{/);
});

test("invalid JSON retains the last good allowlist", () => {
  const files = makeFs();
  const { errors, logger } = quietLogger();
  const allowlist = createAllowlist({ path: "allowlist.json", fsImpl: files.fsImpl, logger });
  files.setContent(JSON.stringify({ owners: ["owner@example.com"], viewers: [] }));
  assert.equal(allowlist.getRole("owner@example.com"), "owner");
  files.setContent("{ invalid", 3);
  assert.equal(allowlist.getRole("owner@example.com"), "owner");
  assert.equal(allowlist.getRole("stranger@example.com"), null);
  assert.equal(errors.length, 1);
});

test("allowlist reloads when mtime changes", () => {
  const files = makeFs();
  const allowlist = createAllowlist({ path: "allowlist.json", fsImpl: files.fsImpl, logger: { error() {} } });
  files.setContent(JSON.stringify({ owners: ["owner@example.com"], viewers: [] }));
  assert.equal(allowlist.getRole("owner@example.com"), "owner");
  files.setContent(JSON.stringify({ owners: [], viewers: ["owner@example.com"] }));
  assert.equal(allowlist.getRole("owner@example.com"), "viewer");
});

test("email lookup trims and lowercases, with owner taking precedence", () => {
  const files = makeFs();
  files.setContent(JSON.stringify({
    owners: [" Owner@Example.com "],
    viewers: ["owner@example.com", " Viewer@Example.com "],
  }));
  const allowlist = createAllowlist({ path: "allowlist.json", fsImpl: files.fsImpl, logger: { error() {} } });
  assert.equal(allowlist.getRole(" OWNER@example.com "), "owner");
  assert.equal(allowlist.getRole("viewer@example.com"), "viewer");
  assert.equal(allowlist.getRole("other@example.com"), null);
});

test("invalid allowlist shape denies when no valid file has loaded", () => {
  const files = makeFs();
  files.setContent(JSON.stringify({ owners: ["owner@example.com"], viewers: "not-an-array" }));
  const allowlist = createAllowlist({ path: "allowlist.json", fsImpl: files.fsImpl, logger: { error() {} } });
  assert.equal(allowlist.getRole("owner@example.com"), null);
});
