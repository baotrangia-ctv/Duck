# Documentation and module index

## Reading order for a new agent

1. Read [the root agent guide](../AGENTS.md) for commands, conventions, and task lookup.
2. Read [architecture](architecture.md) for module boundaries, process state, and concurrency.
3. Read [flows](flows.md) for callback, confirmation, update, OAuth, and dashboard behavior.
4. Read [extraction](extraction.md) before changing PIC, deadline, priority, prompt, or fixtures.
5. Read [integrations and config](integrations-and-config.md) before touching APIs or credentials.
6. Use [testing](testing.md), [gotchas](gotchas.md), and [git workflow](git-workflow.md) while changing code.

## Documents

| Document | Purpose | Read when |
|---|---|---|
| [../AGENTS.md](../AGENTS.md) | Primary Codex instructions and concise repo guide | Starting any task |
| [../CLAUDE.md](../CLAUDE.md) | Imports AGENTS.md and adds Claude Code notes | Starting Claude Code |
| [INDEX.md](INDEX.md) | Navigation hub, reading order, and glossary | Finding any document or module |
| [architecture.md](architecture.md) | Dependency direction, process state, and race guards | Changing server orchestration or state |
| [flows.md](flows.md) | End-to-end behavior and callback values | Changing a user-facing flow |
| [extraction.md](extraction.md) | Provider selection, precedence, dates, and fixtures | Changing task extraction |
| [integrations-and-config.md](integrations-and-config.md) | Environment, endpoints, SeaTalk and Google contracts | Changing configuration or integrations |
| [testing.md](testing.md) | Test commands, suites, fakes, and coverage gaps | Before and after code changes |
| [gotchas.md](gotchas.md) | High-impact traps and known source/spec mismatches | Before implementation or deployment |
| [git-workflow.md](git-workflow.md) | Binding branch, commit, and pre-commit rules | Before every commit |
| [codex-prompt-agent-docs.md](codex-prompt-agent-docs.md) | Authoring prompt for this documentation set | Revising the agent-doc requirements |
| [../src/AGENTS.md](../src/AGENTS.md) and [../src/CLAUDE.md](../src/CLAUDE.md) | Source-module local rules and Claude import | Changing src modules |
| [../rules/AGENTS.md](../rules/AGENTS.md) and [../rules/CLAUDE.md](../rules/CLAUDE.md) | Extraction policy editing rules and Claude import | Changing rules/*.md |
| [../test/AGENTS.md](../test/AGENTS.md) and [../test/CLAUDE.md](../test/CLAUDE.md) | Test conventions and Claude import | Changing tests or fixtures |
| [../README.md](../README.md) | Vietnamese local setup and product behavior notes | Checking setup and user-facing behavior |

## Source and support modules

| Path | Purpose | Key exports / entry points | Read when |
|---|---|---|---|
| [../server.js](../server.js) | HTTP server, routes, in-memory orchestration | handleWebhook, processTask, confirmTask, createServer handler | Changing routes or end-to-end behavior |
| [../src/task-extractor.js](../src/task-extractor.js) | Rules, hints, LLM requests, date and field resolution | createTaskExtractor, normalizeDeadline, extractPayloadHints, parseTaskFields | Changing extraction |
| [../src/seatalk.js](../src/seatalk.js) | SeaTalk client and outbound text/card shapes | SeaTalkClient, buildConfirmationMessage, buildTaskClarificationMessage | Changing SeaTalk messages |
| [../src/google-sheets.js](../src/google-sheets.js) | OAuth token lifecycle and Sheets REST calls | GoogleSheetsClient, buildTaskRow | Changing Sheets or OAuth |
| [../src/thread-sessions.js](../src/thread-sessions.js) | Thread tasks and clarification routing | createThreadSession, resolveTaskRoute, reopenTaskForConfirmation | Changing thread task behavior |
| [../src/confirmation-auth.js](../src/confirmation-auth.js) | Creator, PIC, and clicker authorization | isConfirmationClickAuthorized, isTaskMessageUpdateAuthorized | Changing permissions |
| [../src/confirmation-routing.js](../src/confirmation-routing.js) | SeaTalk callback value parser | parseConfirmationButtonValue | Changing interactive buttons |
| [../src/sheet-task-updates.js](../src/sheet-task-updates.js) | Natural-language intent and row conversion/matching | detectTaskIntent, extractRequestedStatus, findMatchingSheetTasks | Changing Phase 2 update parsing |
| [../rules/PIC_POLICY.md](../rules/PIC_POLICY.md) | PIC policy injected into the extraction prompt | — | Changing assignment interpretation |
| [../rules/DEADLINE_POLICY.md](../rules/DEADLINE_POLICY.md) | Deadline policy injected into the extraction prompt | — | Changing date interpretation |
| [../rules/TASK_PRIORITY_POLICY.md](../rules/TASK_PRIORITY_POLICY.md) | Priority policy injected into the extraction prompt | — | Changing priority interpretation |
| [../test/task-extractor.test.js](../test/task-extractor.test.js) | Extraction, date, prompt, card, auth, and client tests | node:test cases | Changing extractor or card behavior |
| [../test/sheet-task-updates.test.js](../test/sheet-task-updates.test.js) | Update intent, row matching, and PIC update authorization | node:test cases | Changing Sheet updates |
| [../test/thread-sessions.test.js](../test/thread-sessions.test.js) | Thread routing, clarification, and card limits | node:test cases | Changing sessions or clarification |
| [../test/fixtures/extraction-cases.json](../test/fixtures/extraction-cases.json) | Rule-evaluator expectations (46 cases currently) | message, deadline, priority, task | Changing extraction behavior |
| [../test/eval-extract](../test/eval-extract) | Fixture evaluator CLI | --provider, --reference-date, --details | Measuring extraction changes |
| [../public/app.js](../public/app.js) | Dashboard rendering and SSE handling | EventSource /api/stream | Changing dashboard behavior |
| [../public/index.html](../public/index.html) | Dashboard structure | — | Changing dashboard controls or markup |
| [../public/styles.css](../public/styles.css) | Dashboard presentation | — | Changing dashboard appearance |
| [../package.json](../package.json) | Scripts and ESM package metadata | start, dev, test, eval:extract | Changing commands or dependencies |
| [../.env.example](../.env.example) | Documented environment variable names and sample defaults | — | Changing configuration |

## Glossary

| Term | Meaning in this repo |
|---|---|
| PIC | Person in Charge: the assignee. Sheet PIC is an email; SeaTalk DMs use the PIC employee_code when available. |
| Draft | An in-memory, not-yet-confirmed task in a thread session. draftId identifies the callback; shortId is the thread-local display number. |
| Thread session | Process-local task collection keyed by group/thread or direct-chat identity; it holds tasks and pending clarifications. |
| Clarification | A card asking whether an unquoted message starts a new task or revises one of up to five recent tasks. |
| Quote / quoted message | SeaTalk quotedMessageId used to find a task source, confirmation, assignment, or remembered Sheet-related message. |
| Sheet Task ID | Numeric ID in Google Sheet column A, generated as max(ID)+1. It is different from a thread-local shortId. |
| employee_code | SeaTalk identity used by single-chat sends and, when available, PIC notification routing. |
| Reference date | Calendar date used to resolve relative deadlines; runtime uses Asia/Ho_Chi_Minh. Evaluator defaults to 2026-10-22. |
| skipSheet | Internal demo-processing option passed by /api/test-message; extraction runs while outbound confirmation is suppressed and Sheet status is marked skipped. |
| P0 / P1 / P2 | Urgent / important / normal priority values written to the Sheet. |
| Confirmation card | SeaTalk interactive_message showing a draft with priority/deadline quick picks and a Confirm callback. |
| Assignment notification | Direct SeaTalk message to the PIC after a successful Sheet write. |
