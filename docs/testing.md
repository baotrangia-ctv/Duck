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
| test/google-service-account.test.js | Generated-key JWT signature/claims, token cache and concurrent refresh, invalid key handling |
| test/google-sheets.test.js | Service-account status, Sheet access cache, and 403/404 error mapping |
| test/allowlist.test.js | Missing/invalid files, mtime reloads, email normalization, and role precedence |
| test/session.test.js | HMAC cookies, tampering/expiry, renewal threshold, flags, and secret persistence |
| test/access-control.test.js | Public/viewer/owner route matrix, HTML redirects, unknown routes, loopback and same-origin policy |
| test/google-login.test.js | Signed OAuth state, restart/expiry, cookie binding, error codes and safe logs, host redirect, login-page behavior, verified email, allowlist, and session issuance |
| test/task-acknowledgement.test.js | PIC-only acknowledgement, Sheet re-read/write, UpdatedAt, idempotence, final statuses, and card update |
| test/task-reminder.test.js | Command variants/negatives/cap, Vietnam deadline math, per-task DM routing, skip/failure isolation and integration gates |
| test/seatalk-reminder.test.js | Exact reminder/DONE cards, additive callback parsing, documented contacts response, positive email cache, employee statuses/ambiguity and API code 103 |
| test/task-done.test.js | PIC-only status CAS, UpdatedAt, already DONE, gates, missing row, CAS miss, three concurrent clicks, fallback DM and retry |
| test/server-reminder.test.js | Isolated server orchestration: reminder interception, skipSheet dry run, thread filter, old routes and DONE webhook dispatch |
| test/sheet-task-updates.test.js | Update-intent/status parsing, A:I row conversion and Creator preservation, Sheet client lookup, update cards, PIC/Creator authorization and PIC notification routing |
| test/thread-sessions.test.js | Session/task routing, quoted messages, clarification choices, five-task limit, short IDs, reopening |
| test/fixtures/extraction-cases.json | 46 input messages with deadline, priority, and task expectations |
| test/eval-extract | CLI evaluator for fixture exact-match rates |

There is no direct test import of server.js. Reminder tests evaluate selected orchestration
functions in a VM with injected fakes to avoid startup credential-file reads and network calls.
They exercise routing but do not start an HTTP listener. Full HTTP route handling, webhook
signature validation, deduplication and SSE lifecycle still lack a server-level integration
suite. A local HTTP smoke check remains useful before deployment when credential-file access
is permitted. Contacts tests follow the official `employees` response using fakes; they do not
verify deployed app permissions or Service Scope. Live read-only diagnosis requires authorization.

## Fakes and fixture workflow

- task-extractor.test.js replaces globalThis.fetch for Chatflow/Compass calls and restores it
  in finally. SeaTalkClient accepts a fetchImpl constructor option for outbound call tests.
- Google service-account tests generate throwaway RSA keys and fake the token endpoint. Sheets
  tests inject token providers or replace readValues; no live Google account is used.
- Google login tests fake both Google endpoints and use in-memory allowlist/session dependencies.
- Auth tests use in-memory file adapters and deterministic session secrets; they do not open `.auth/`.
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
| Authorization | confirmation-auth.js plus allowlist/session/access-control/login suites; inspect server call sites |
| Sheet columns, row IDs, or service-account auth | google-sheets.js, google-service-account.js, integrations docs, and client tests; treat contract changes as breaking |
| HTTP/SSE flow | server.js and public/app.js; current tests do not exercise server.js directly |
| Google login | google-login.test.js covers signed state across instances, error codes and safe logs, account choice, host matching, and login-page messages; HTTP route wiring still needs a local smoke check |
| Environment names/defaults | .env.example, server.js reads, integrations docs; treat runtime-changing changes as breaking |

## Local HTTP smoke check

Run the server on loopback with `TASK_EXTRACTOR=rules`, a temporary allowlist file outside the
repository, `AUTH_SESSION_SECRET` set for the smoke process, and no Google credentials. Verify
that `GET /` redirects to `/login`, `GET /api/messages` returns 401, `GET /healthz` returns
`{ "ok": true }`, a SeaTalk `event_verification` POST returns 200, `/login` returns 200, and
`GET /auth/google` returns 404. Stop the server after the checks; do not perform Google login.
