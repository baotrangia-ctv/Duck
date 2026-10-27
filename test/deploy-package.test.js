import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const windows = process.platform === "win32";
const script = resolve(".agents/skills/deploy-duck/scripts/build-demo-zip.ps1");
const runtimeKeys = [...readFileSync("server.js", "utf8").matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((match) => match[1]);

function cleanup(root) {
  const target = resolve(root);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("duck-package-test-"));
  rmSync(target, { recursive: true, force: true });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "duck-package-test-"));
  mkdirSync(join(root, "credentials"));
  mkdirSync(join(root, ".auth"));
  writeFileSync(join(root, "credentials/access.json"), JSON.stringify({ owners: ["owner@example.com"], viewers: [] }));
  writeFileSync(join(root, "credentials/sheets.json"), JSON.stringify({
    client_email: "fake@example.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nOFFLINE_FIXTURE_ONLY\n-----END PRIVATE KEY-----\n",
    token_uri: "https://oauth2.googleapis.com/token",
  }));
  writeFileSync(join(root, ".auth/session-secret"), "offline-persisted-session-secret");
  writeFileSync(join(root, ".auth/unrelated-key.json"), "must-not-ship");
  const lines = [
    "SEATALK_SIGNING_SECRET=offline-signing-secret", "SEATALK_APP_ID=offline-app-id", "SEATALK_APP_SECRET=offline-app-secret",
    "SEATALK_ACCESS_TOKEN=offline-stale-token", "GOOGLE_OAUTH_CLIENT_ID=offline-client", "GOOGLE_OAUTH_CLIENT_SECRET=offline-oauth-secret",
    "GOOGLE_SHEETS_SPREADSHEET_ID=offline-sheet", "GOOGLE_SHEETS_WRITE_ENABLED=false", "GOOGLE_SHEETS_SHEET_NAME=Tasks",
    "GOOGLE_SERVICE_ACCOUNT_KEY_PATH=credentials/sheets.json", "AUTH_ALLOWLIST_PATH=credentials/access.json",
    "CHATFLOW_API_URL=https://example.invalid/extract", "CHATFLOW_API_TOKEN=offline-chatflow-secret",
    "COMPASS_API_KEY=offline-compass-secret", "GOOGLE_OAUTH_TOKEN_PATH=retired-token-path",
    "GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3030/auth/google/callback",
  ];
  writeFileSync(join(root, ".env"), lines.join("\n") + "\n");
  return { root, zip: join(root, "deploy.zip") };
}

function build(context, extra = []) {
  const env = { ...process.env };
  for (const key of runtimeKeys) delete env[key];
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script,
    ...(extra.includes("-Extractor") ? [] : ["-Extractor", "rules"]), "-ConfigRoot", context.root, "-OutputZip", context.zip, ...extra], { encoding: "utf8", env });
}

function inspect(zipPath) {
  const command = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "Add-Type -AssemblyName System.IO.Compression",
    "$zip = [System.IO.Compression.ZipFile]::OpenRead($env:DUCK_TEST_ARCHIVE)",
    "try { $reader = [System.IO.StreamReader]::new($zip.GetEntry('.env').Open()); try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }; [pscustomobject]@{ entries = @($zip.Entries | ForEach-Object { $_.FullName }); env = $content } | ConvertTo-Json -Compress } finally { $zip.Dispose() }",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", env: { ...process.env, DUCK_TEST_ARCHIVE: zipPath } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("deployment ZIP carries all selected integration inputs, portable auth files and committed source without unrelated secrets", { skip: !windows }, () => {
  const context = fixture();
  try {
    const original = readFileSync(join(context.root, ".env"), "utf8");
    const result = build(context);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(result.stdout);
    assert.equal(metadata.resolvedExtractor, "rules");
    assert.equal(metadata.seaTalkMode, "app_credentials");
    assert.equal(metadata.sessionContinuity, "persisted_file");
    assert.deepEqual(metadata.omittedUnknownVariableNames, ["GOOGLE_OAUTH_TOKEN_PATH"]);
    assert.doesNotMatch(result.stdout + result.stderr, /offline-app-secret|offline-oauth-secret|offline-signing-secret/);
    const archive = inspect(context.zip);
    assert.ok(archive.entries.includes("server.js"));
    assert.deepEqual(archive.entries.filter((path) => path.startsWith(".auth/")).sort(), [".auth/allowlist.json", ".auth/google-service-account.json", ".auth/session-secret"]);
    assert.ok(!archive.entries.some((path) => /(^|\/)(?:test|docs|node_modules|\.git|\.oauth)\//.test(path)));
    assert.match(archive.env, /SEATALK_APP_SECRET=offline-app-secret/);
    assert.match(archive.env, /GOOGLE_OAUTH_CLIENT_SECRET=offline-oauth-secret/);
    assert.match(archive.env, /GOOGLE_SHEETS_SPREADSHEET_ID=offline-sheet/);
    assert.match(archive.env, /GOOGLE_SHEETS_WRITE_ENABLED=false/);
    assert.match(archive.env, /HOST=0\.0\.0\.0/);
    assert.match(archive.env, /PORT=3000/);
    assert.match(archive.env, /AUTH_DISABLED=false/);
    assert.match(archive.env, /GOOGLE_OAUTH_REDIRECT_URI=https:\/\/craftland-duck\.demo\.ved\.com\.vn\/auth\/google\/callback/);
    assert.match(archive.env, /GOOGLE_SERVICE_ACCOUNT_KEY_PATH=\.auth\/google-service-account.json/);
    assert.doesNotMatch(archive.env, /SEATALK_ACCESS_TOKEN|CHATFLOW_|COMPASS_|GOOGLE_OAUTH_TOKEN_PATH|credentials\//);
    assert.equal(readFileSync(join(context.root, ".env"), "utf8"), original);
  } finally { cleanup(context.root); }
});

test("deployment preflight rejects missing keys and unsafe public settings without leaving archives", { skip: !windows }, () => {
  for (const scenario of ["missing_key", "auth_disabled", "loopback", "provider_missing"]) {
    const context = fixture();
    try {
      let env = readFileSync(join(context.root, ".env"), "utf8");
      if (scenario === "missing_key") rmSync(join(context.root, "credentials/sheets.json"));
      if (scenario === "auth_disabled") env += "AUTH_DISABLED=true\n";
      if (scenario === "provider_missing") env = env.replace(/^CHATFLOW_API_TOKEN=.*\n/m, "");
      writeFileSync(join(context.root, ".env"), env);
      const args = scenario === "loopback" ? ["-PublicOrigin", "https://localhost"] : scenario === "provider_missing" ? ["-Extractor", "chatflow"] : [];
      const result = build(context, args);
      assert.notEqual(result.status, 0);
      const expected = { missing_key: /key file is missing/, auth_disabled: /AUTH_DISABLED=true/, loopback: /public HTTPS origin/, provider_missing: /Chatflow extractor is missing/ };
      assert.match(result.stderr, expected[scenario]);
      assert.equal(existsSync(context.zip), false);
      assert.doesNotMatch(result.stdout + result.stderr, /offline-app-secret|offline-oauth-secret|offline-signing-secret/);
    } finally { cleanup(context.root); }
  }
});

test("Chatflow packaging includes its selected credentials without shipping the other provider", { skip: !windows }, () => {
  const context = fixture();
  try {
    const result = build(context, ["-Extractor", "chatflow"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).resolvedExtractor, "chatflow");
    const archive = inspect(context.zip);
    assert.match(archive.env, /CHATFLOW_API_TOKEN=offline-chatflow-secret/);
    assert.match(archive.env, /TASK_EXTRACTOR=chatflow/);
    assert.doesNotMatch(archive.env, /COMPASS_/);
  } finally { cleanup(context.root); }
});

test("environment example documents supported runtime variables and has no obsolete assignments", () => {
  const example = readFileSync(".env.example", "utf8");
  const names = [...example.matchAll(/^\s*(?:#\s*)?([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1]);
  assert.deepEqual([...new Set(names)].sort(), [...new Set(runtimeKeys)].sort());
});
