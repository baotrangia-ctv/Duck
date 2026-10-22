# test conventions

- Use Node's built-in node:test and node:assert/strict; keep tests deterministic and offline.
- Restore globalThis.fetch in finally blocks. Prefer SeaTalkClient's fetchImpl injection
  when testing outbound SeaTalk requests; stub client methods for Sheets reads as needed.
- Add extraction cases to fixtures/extraction-cases.json with message, deadline, priority,
  and task expectations, anchored to the evaluator's reference date 2026-10-22.
- When behavior changes, update tests for the affected module and run npm test.
- Run node test/eval-extract --provider rules when changing extraction code, rules, or fixtures.
- server.js route/orchestration behavior currently has no direct test import; mention this
  coverage limit when changing or relying on HTTP behavior.
