import test from "node:test";
import assert from "node:assert/strict";
import { SeaTalkClient, buildTaskReminderMessage, buildTaskDoneMessage } from "../src/seatalk.js";
import { parseConfirmationButtonValue } from "../src/confirmation-routing.js";

test("reminder and completed cards preserve exact copy, format and callback shape", () => {
  const task = { id: 12, task: "Làm báo cáo", priority: "P1", deadline: "28/10/2026", status: "IN PROGRESS" };
  const card = buildTaskReminderMessage(task, { now: "2026-10-27T05:00:00Z" });
  assert.equal(card.tag, "interactive_message");
  assert.deepEqual(card.interactive_message.elements, [
    { element_type: "title", title: { text: "🚨 [P1] Task Deadline Alert" } },
    { element_type: "description", description: { format: 1, text: "**Task:** Làm báo cáo\n**Deadline:** 28/10/2026\n**Progress:** IN PROGRESS\n**Status:** Còn 1 ngày đến Deadline" } },
    { element_type: "button", button: { button_type: "callback", text: "✅ DONE", value: "task:done:12" } },
  ]);
  const done = buildTaskDoneMessage(task).interactive_message.elements;
  assert.equal(done[0].title.text, "✅ Đã hoàn thành");
  assert.equal(done.some((element) => element.element_type === "button"), false);
  assert.match(done[1].description.text, /\*\*Status:\*\* DONE/);
  const empty = buildTaskReminderMessage({ id: 1 }).interactive_message.elements;
  assert.match(empty[0].title.text, /Chưa xác định/);
  assert.match(empty[1].description.text, /\*\*Task:\*\* Chưa xác định/);
  assert.match(empty[1].description.text, /Chưa xác định Deadline/);
});

test("DONE callback parser is additive and rejects invalid suffixes", () => {
  assert.deepEqual(parseConfirmationButtonValue("task:done:12"), { kind: "task_done", taskId: 12 });
  assert.deepEqual(parseConfirmationButtonValue("task:ack:12"), { kind: "task_ack", taskId: 12 });
  assert.deepEqual(parseConfirmationButtonValue("task:confirm:draft"), { kind: "confirm", draftId: "draft" });
  for (const value of ["task:done:abc", "task:done:-1", "task:done:12:extra", "task:done:"]) assert.equal(parseConfirmationButtonValue(value), null);
});

test("employee lookup uses the documented employees response and caches only positive matched emails", async () => {
  const calls = [];
  const client = new SeaTalkClient({ accessToken: "fake", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ code: 0, employees: [
      { code: 0, email: "other@example.com", employee_code: "wrong", employee_status: 2 },
      { code: 0, email: "pic@example.com", employee_code: "old", employee_status: 4 },
      { code: 0, email: "pic@example.com", employee_code: "PIC", employee_status: 2 },
    ] }) };
  } });
  assert.equal(await client.getEmployeeCodeByEmail(" PIC@Example.com "), "PIC");
  assert.equal(await client.getEmployeeCodeByEmail("pic@example.com"), "PIC");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openapi.seatalk.io/contacts/v2/get_employee_code_with_email");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { emails: ["pic@example.com"] });
  assert.equal(await client.getEmployeeCodeByEmail("missing@example.com"), null);
  assert.equal(await client.getEmployeeCodeByEmail("missing@example.com"), null);
  assert.equal(calls.length, 3);
  assert.equal(await client.getEmployeeCodeByEmail("invalid"), null);
  assert.equal(calls.length, 3);
});

test("employee lookup surfaces API errors without caching a missing result", async () => {
  let calls = 0;
  const client = new SeaTalkClient({ accessToken: "fake", fetchImpl: async () => {
    calls++;
    return { ok: calls > 1, status: calls > 1 ? 200 : 403, json: async () => calls > 1 ? { code: 0, employees: [] } : { code: 403 } };
  } });
  await assert.rejects(client.getEmployeeCodeByEmail("pic@example.com"), /403/);
  assert.equal(await client.getEmployeeCodeByEmail("pic@example.com"), null);
  assert.equal(calls, 2);
});

test("employee lookup rejects not-found, terminated and ambiguous identities and prefers an in-position employee", async () => {
  const employee = (employee_code, employee_status = 2, code = 0) => ({ email: "pic@example.com", employee_code, employee_status, code });
  const cases = [
    [[employee(null, 0, 3000)], null],
    [[employee("former", 4)], null],
    [[employee("a"), employee("b")], null],
    [[employee("pending", 1), employee("current"), employee("leaving", 3)], "current"],
    [[employee("leaving", 3)], "leaving"],
    [[employee("pending", 1)], "pending"],
    [[employee("unknown", 0)], null],
    [[employee("", 2)], null],
  ];
  for (const [employees, expected] of cases) {
    const client = new SeaTalkClient({ accessToken: "fake", fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, employees }) }) });
    assert.equal(await client.getEmployeeCodeByEmail("pic@example.com"), expected);
  }
});

test("HTTP 200 with app permission denied is an API failure and is not cached", async () => {
  let calls = 0;
  const client = new SeaTalkClient({ accessToken: "fake", fetchImpl: async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ code: 103, message: "app permission denied" }) };
  } });
  await assert.rejects(client.getEmployeeCodeByEmail("pic@example.com"), /HTTP 200 app permission denied/);
  await assert.rejects(client.getEmployeeCodeByEmail("pic@example.com"), /app permission denied/);
  assert.equal(calls, 2);
});
