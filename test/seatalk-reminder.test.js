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

test("employee lookup isolates the provisional POST contract and caches only positive matched emails", async () => {
  const calls = [];
  const client = new SeaTalkClient({ accessToken: "fake", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ code: 0, results: [{ email: "other@example.com", employee_code: "wrong" }, { email: "pic@example.com", employee_code: "PIC", exists: true }] }) };
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
    return { ok: calls > 1, status: calls > 1 ? 200 : 403, json: async () => calls > 1 ? { code: 0, results: [] } : { code: 403 } };
  } });
  await assert.rejects(client.getEmployeeCodeByEmail("pic@example.com"), /403/);
  assert.equal(await client.getEmployeeCodeByEmail("pic@example.com"), null);
  assert.equal(calls, 2);
});
