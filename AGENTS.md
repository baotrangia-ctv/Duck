# Agent guide

## What this is

Alpha Intel SeaTalk inbox is a dependency-free Node.js HTTP server for SeaTalk callbacks.
It parses task requests from Vietnamese chat, prepares confirmation cards, and can write
confirmed tasks to Google Sheets. A static dashboard displays recent events and extraction
state in real time. Dashboard and API access require a signed session for an account in the
owner/viewer allowlist; SeaTalk webhook routes remain server-to-server.

## Quick start

Requirements: Node.js 18+ (README requirement; package.json does not declare engines).

    npm install
    npm start                 # node server.js
    npm run dev               # node --watch server.js
    npm test                  # node --test
    npm run eval:extract -- --provider rules

The rules-only extractor needs no external credentials. To run the dashboard in PowerShell
without an LLM provider, set $env:TASK_EXTRACTOR = "rules" before npm start. Create
`.auth/allowlist.json` from `allowlist.example.json` and configure the Google OAuth client for
login. For a trusted local-only session, set `$env:HOST = "127.0.0.1"` and
`$env:AUTH_DISABLED = "true"`. POST http://localhost:3030/api/test-message to create a local
sample; it extracts fields without sending a confirmation card or writing a Sheet row. The
default server bind is 0.0.0.0:3030 and requires `SEATALK_SIGNING_SECRET`.

## Repo map

| Path | Responsibility |
|---|---|
| server.js (~1,430 lines) | HTTP routes, orchestration, in-memory state |
| src/task-extractor.js (~864 lines) | Prompt, date rules, hints, provider calls |
| src/seatalk.js | SeaTalk API client and message/card builders |
| src/google-sheets.js | Google Sheets REST API, service-account auth, row reads/writes |
| src/google-service-account.js | Service-account key loading, signed JWTs, cached access tokens |
| src/allowlist.js | Reloadable owner/viewer allowlist with fail-closed behavior |
| src/session.js | Signed, sliding dashboard session cookies |
| src/google-login.js | Google login state, token exchange, verified-email allowlisting |
| src/access-control.js | Dashboard/API route-role table and same-origin checks |
| src/thread-sessions.js | In-memory thread/task model and routing |
| src/confirmation-auth.js | Identity checks for confirmations and updates |
| src/confirmation-routing.js | Callback button-value parser |
| src/task-acknowledgement.js | PIC-only, restart-safe TODO acknowledgement handler |
| src/sheet-task-updates.js | Update intent/status parsing and row matching |
| rules/*.md | PIC, deadline, and priority extraction policies |
| public/ | Static dashboard; app.js consumes API and SSE events |
| test/ | node:test suites, extraction evaluator, fixtures |
| docs/ | Agent entry points, architecture, flows, config, testing, gotchas |

## Architecture in 10 lines

1. SeaTalk POSTs events to /callback (also /seatalk/callback and /webhook/seatalk).
2. handleWebhook parses JSON, optionally checks the Signature header, and deduplicates events.
3. parseSeaTalkEvent normalizes message, interaction, and verification payloads.
4. shouldProcessMessage filters thread replies; processTask routes task and Sheet-update work.
5. resolveTaskRoute and detectTaskIntent choose a new task, draft revision, clarification, or Sheet update.
6. createTaskExtractor combines local rules, payload hints, and an optional Chatflow or Compass call.
7. The task is kept in threadSessions and shown in a SeaTalk interactive confirmation card.
8. The dashboard checks the signed session and current allowlist role; a valid Confirm click
   checks task identity, required fields, Sheet configuration, and service-account access.
9. GoogleSheetsClient appends a TODO row; the PIC receives an interactive DM and can acknowledge it
   to set IN PROGRESS.
10. Dashboard/API routes require an allowlisted session; snapshots and processing changes use
    /api/stream SSE, while webhook routes stay public for SeaTalk callbacks.

See [docs/architecture.md](docs/architecture.md) and [docs/flows.md](docs/flows.md).

## Conventions

- ESM via package.json type=module; no runtime npm dependencies; built-in fetch and node:http.
- Tests use node:test and node:assert/strict. Replace globalThis.fetch in a try/finally for
  LLM/Google HTTP fakes; SeaTalkClient accepts fetchImpl. Tests also replace client methods.
- Use camelCase functions/variables, PascalCase classes, double quotes, semicolons, and
  two-space indentation. Keep comments short and attached to non-obvious constraints.
- Recent commit prefixes in git log include feat, fix, test, and chore; follow the workflow below.

## Always / Never

- Keep user-facing bot copy in Vietnamese. Write agent documentation in English.
- Never read, print, or commit .env, .auth/, .oauth/, or any service-account key. Use .env.example for names.
- Keep rules/*.md, deterministic extraction code, EXTRACTION_PROMPT examples, fixtures, and
  tests aligned. Rule files are loaded when task-extractor.js is imported; restart the server.
- Preserve the Google Sheet A–I contract, task button-value grammar, endpoint meanings, and
  authorization behavior unless deliberately making a breaking change.
- Dashboard and API routes require a signed session and a current allowlist role. CORS headers
  are not sent; mutating dashboard requests validate Origin against Host.
- SeaTalk webhook routes remain public and are protected only when SEATALK_SIGNING_SECRET is
  set. An empty secret accepts unsigned callbacks; non-loopback binds require a nonempty secret.
- AUTH_DISABLED=true works only with a loopback HOST; never expose it on an untrusted network.

## Git workflow & commit convention

- Work on master only. First run git branch --show-current and git status --short; if not on
  master, stop and ask. Never create, rename, or switch branches.
- After each completed implementation with green required checks, commit automatically.
  Commit documentation too; leave failed work uncommitted. Never push or open a PR.
- Stage explicit paths only. Inspect git diff --cached --stat and git diff --cached; exclude
  pre-existing user changes and secrets. Run checks, commit, then inspect git log -1 --stat.
- Use Conventional Commits 1.0.0: <type>(<scope>)!: <imperative, lowercase description>.
  Allowed types: feat, fix, docs, test, refactor, perf, style, build, ci, chore, revert.
- Allowed scopes: extractor, deadline, priority, pic, prompt, seatalk, card, sheets,
  sheet-update, thread, auth, routing, server, dashboard, config, eval, rules, deps.
- Use ! and/or BREAKING CHANGE when changing A–I/ID/header contract, callback button grammar,
  runtime-changing env names/defaults, endpoint meaning/aliases, or task authorization.
- Never push, amend, rebase, hard-reset, bypass hooks, clean user files, or change git config.
- Follow [docs/git-workflow.md](docs/git-workflow.md) for the complete policy and recipe.

## Where to look when…

| Work | Start here |
|---|---|
| Change deadline or priority parsing | rules/DEADLINE_POLICY.md, rules/TASK_PRIORITY_POLICY.md, normalizeDeadline and resolvePriority in src/task-extractor.js, fixtures and tests |
| Change PIC detection | rules/PIC_POLICY.md and extractPayloadHints in src/task-extractor.js |
| Change draft/thread routing | resolveTaskRoute in src/thread-sessions.js; processTask in server.js |
| Change confirmation permissions or buttons | src/confirmation-auth.js, src/confirmation-routing.js, src/seatalk.js |
| Change Sheet writes or service-account auth | src/google-sheets.js, src/google-service-account.js and server.js; see docs/integrations-and-config.md |
| Change dashboard or SSE | public/app.js and server.js handleStream/broadcast |
| Add extraction coverage | test/fixtures/extraction-cases.json, test/task-extractor.test.js, docs/testing.md |

## Doc index

- [docs/INDEX.md](docs/INDEX.md) — reading order, glossary, module index.
- [docs/architecture.md](docs/architecture.md) — modules, state, and concurrency.
- [docs/flows.md](docs/flows.md) — callback, task, update, service-account, and dashboard flows.
- [docs/extraction.md](docs/extraction.md) — provider and field precedence details.
- [docs/integrations-and-config.md](docs/integrations-and-config.md) — env vars, routes, SeaTalk, Sheets.
- [docs/testing.md](docs/testing.md) — suites, fakes, evaluator, and change checklist.
- [docs/gotchas.md](docs/gotchas.md) — source-verified traps and known mismatches.
- [docs/git-workflow.md](docs/git-workflow.md) — full local commit policy.
- [docs/codex-prompt-agent-docs.md](docs/codex-prompt-agent-docs.md) — source prompt used to request this documentation set.
