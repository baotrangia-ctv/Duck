# Testing

## Commands

    npm test
    node --test test/task-extractor.test.js
    node --test --test-name-pattern "rules provider" test/task-extractor.test.js
    node test/eval-extract --provider rules
    node test/eval-extract --provider rules --reference-date 2026-10-22 --details

The test script is node --test. The evaluator defaults its reference date to 2026-10-22 and
compares fixture expectations for deadline, priority, and task.

## Test layout

| File | Coverage |
|---|---|
| test/task-extractor.test.js | JSON parsing, prompt, deterministic and mocked LLM extraction, deadlines, priorities, revisions, card builders, SeaTalk calls and auth |
| test/sheet-task-updates.test.js | Update-intent/status parsing, A:I row conversion and Creator preservation, Sheet client lookup, update cards, PIC/Creator authorization and PIC notification routing |
| test/thread-sessions.test.js | Session/task routing, quoted messages, clarification choices, five-task limit, short IDs, reopening |
| test/fixtures/extraction-cases.json | 46 input messages with deadline, priority, and task expectations |
| test/eval-extract | CLI evaluator for fixture exact-match rates |

There is no direct test import of server.js. HTTP route handling, webhook signature validation,
deduplication, SSE lifecycle, OAuth route/state handling, and orchestration across modules
are not covered by a server-level test suite.

## Fakes and fixture workflow

- task-extractor.test.js replaces globalThis.fetch for Chatflow/Compass calls and restores it
  in finally. SeaTalkClient accepts a fetchImpl constructor option for outbound call tests.
- Google Sheets tests replace readValues or call pure row helpers; tests do not require a live
  Google account. Keep new tests offline.
- A fixture has message, deadline, priority, and task fields. Use the evaluator's pinned
  reference date for relative dates, or pass --reference-date explicitly.
- Include focused unit tests for edge cases in addition to a fixture when changing parser
  behavior. Fixtures alone do not test PIC/status/auth or the server route.
- Check exact field mismatch output with --details; do not use an external LLM for the rules
  baseline.

## Change checklist

| If you change… | Also update / run… |
|---|---|
| Deadline language or calendar rules | rules/DEADLINE_POLICY.md, task-extractor.js, prompt examples, fixtures, deadline tests, rules eval |
| Priority precedence or defaults | rules/TASK_PRIORITY_POLICY.md, deterministic code, conflicting-priority tests and fixtures, rules eval |
| PIC or mention interpretation | rules/PIC_POLICY.md, payload-hint tests, task-extractor.js |
| Card callback values | confirmation-routing.js, seatalk.js, parser/card tests; preserve existing callback compatibility |
| Authorization | confirmation-auth.js, tests for missing and conflicting identity; inspect server call sites |
| Sheet columns, row IDs, or OAuth | google-sheets.js, integrations docs, row/OAuth tests; treat contract changes as breaking |
| HTTP/SSE flow | server.js and public/app.js; current tests do not exercise server.js directly |
| Environment names/defaults | .env.example, server.js reads, integrations docs; treat runtime-changing changes as breaking |
