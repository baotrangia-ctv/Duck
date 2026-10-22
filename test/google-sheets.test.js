import test from "node:test";
import assert from "node:assert/strict";
import { GoogleSheetsClient } from "../src/google-sheets.js";

function clientWithResponse(status, { now = () => 1_800_000_000_000, fetchImpl } = {}) {
  const tokenProvider = {
    isConfigured: () => true,
    getAccountEmail: () => "sheets-bot@example.com",
    getAccessToken: async () => "access-token",
  };
  return new GoogleSheetsClient({
    spreadsheetId: "sheet-id",
    tokenProvider,
    now,
    fetchImpl: fetchImpl || (async () => ({ ok: status < 400, status, json: async () => ({ spreadsheetId: "sheet-id" }) })),
  });
}

test("Sheets status identifies the service account and a readable sheet", async () => {
  const client = clientWithResponse(200);
  assert.deepEqual(client.getStatus(), {
    configured: true,
    authorized: true,
    accountEmail: "sheets-bot@example.com",
  });
  assert.equal(await client.checkSheetAccess(), true);
});

test("403 maps to a share instruction and marks the service account unauthorized", async () => {
  const client = clientWithResponse(403);
  await assert.rejects(client.readValues("Sheet1!A2:I"), /Chưa truy cập được Google Sheet\. Hãy share Sheet cho sheets-bot@example\.com với quyền Editor\./);
  assert.equal(client.isAuthorized(), false);
  assert.equal(await client.checkSheetAccess(), false);
});

test("404 maps to an actionable spreadsheet ID message", async () => {
  const client = clientWithResponse(404);
  await assert.rejects(client.readValues("Sheet1!A2:I"), /Không tìm thấy Google Sheet\. Kiểm tra GOOGLE_SHEETS_SPREADSHEET_ID và quyền share\./);
});

test("sheet access results are cached for 60 seconds", async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const client = clientWithResponse(200, {
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ spreadsheetId: "sheet-id" }) };
    },
  });
  assert.equal(await client.checkSheetAccess(), true);
  assert.equal(await client.checkSheetAccess(), true);
  assert.equal(calls, 1);
  now += 60_001;
  assert.equal(await client.checkSheetAccess(), true);
  assert.equal(calls, 2);
});

test("find, append, and update keep their Sheets API requests and A-I row shape", async () => {
  const requests = [];
  const existingRow = [7, "Original task", "pic@example.com", "30/09/2026", "P2", "TODO", "created", "updated", "creator@example.com"];
  const client = clientWithResponse(200, {
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), ...options });
      const method = options.method || "GET";
      if (method === "GET" && String(url).includes("A2%3AI")) {
        return { ok: true, status: 200, json: async () => ({ values: [existingRow] }) };
      }
      if (method === "GET" && String(url).includes("A2%3AA")) {
        return { ok: true, status: 200, json: async () => ({ values: [[7]] }) };
      }
      if (method === "GET" && String(url).includes("A2%3AI2")) {
        return { ok: true, status: 200, json: async () => ({ values: [existingRow] }) };
      }
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ updates: { updatedRange: "Sheet1!A3:I3" } }) };
      }
      if (method === "PUT") {
        return { ok: true, status: 200, json: async () => ({ updatedRange: "Sheet1!A2:I2" }) };
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  });

  assert.equal((await client.findTaskById(7)).rowNumber, 2);
  const appended = await client.appendTask({
    task: "New task", pic: "pic@example.com", deadline: "01/10/2026", priority: "P1",
    status: "TODO", createdAt: "new-created", creator: "creator@example.com",
  });
  assert.equal(appended.taskId, 8);
  assert.equal(appended.rowNumber, 3);
  const updated = await client.updateTask(2, {
    id: 7, task: "Updated task", pic: "pic@example.com", deadline: "02/10/2026",
    priority: "P0", status: "IN PROGRESS", createdAt: "created", updatedAt: "changed",
  });
  assert.equal(updated.updatedRange, "Sheet1!A2:I2");

  const get = requests.filter((request) => !request.method || request.method === "GET");
  assert.match(decodeURIComponent(get[0].url), /values\/Sheet1!A2:I$/);
  assert.equal(requests[1].method || "GET", "GET");
  const appendRequest = requests.find((request) => request.method === "POST");
  assert.match(decodeURIComponent(appendRequest.url), /values\/Sheet1!A:I:append\?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS/);
  const appendedRow = JSON.parse(appendRequest.body).values[0];
  assert.equal(appendedRow.length, 9);
  assert.equal(appendedRow[0], 8);
  assert.equal(appendedRow[8], "creator@example.com");
  const updateRequest = requests.find((request) => request.method === "PUT");
  assert.match(decodeURIComponent(updateRequest.url), /values\/Sheet1!A2:I2\?valueInputOption=USER_ENTERED/);
  const updatedRow = JSON.parse(updateRequest.body).values[0];
  assert.equal(updatedRow.length, 9);
  assert.equal(updatedRow[0], 7);
  assert.equal(updatedRow[8], "creator@example.com");
  assert.ok(requests.every((request) => request.headers.Authorization === "Bearer access-token"));
});
