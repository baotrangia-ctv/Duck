# Gotchas

Ordered roughly by blast radius.

## Dashboard/API has no access control

- **What:** The server binds to 0.0.0.0 by default. Dashboard/API routes are unauthenticated,
  JSON and SSE responses allow Access-Control-Allow-Origin: *, and /api/messages returns raw
  event payloads.
- **Why:** A reachable deployment can expose message contents and allow actions such as
  clearing the feed or disconnecting Google.
- **Where:** server.js createServer handler, sendJson, handleStream, and listen setup.
- **Do:** Keep this local/private or put an authenticated boundary in front of it after an
  explicit deployment review. Do not treat CORS as authentication.

## README and current confirmation-card destination disagree

- **What:** README describes an interactive card sent by DM plus text in the group thread and
  says group chat does not accept interactive_message. Current sendConfirmationCard passes
  buildConfirmationMessage to seatalk.sendReply(session.target); group targets use
  sendGroupChat with thread_id. A test expects a group-thread interactive confirmation.
- **Why:** Onboarding docs must not promise the README flow as current runtime behavior.
- **Where:** server.js sendConfirmationCard; src/seatalk.js sendReply/sendGroupChat;
  test/task-extractor.test.js “SeaTalk sends an interactive confirmation into the source group thread”.
- **Do:** Treat code/tests as current behavior and verify the deployed SeaTalk app before
  changing the destination. The documentation task did not alter runtime code.

## Most application state disappears on restart

- **What:** messages is capped at 100; sessions, tasks, drafts, Sheet message references,
  pending clarifications, and SSE clients are process-local. Most maps have no eviction.
- **Why:** Old cards may point to missing drafts; quoted message IDs may no longer resolve.
  DELETE /api/messages clears only the visible message array, not sessions or drafts.
- **Where:** server.js state declarations and addMessage; src/thread-sessions.js.
- **Do:** Do not describe this as durable storage. OAuth tokens are separately persisted in
  the token file, so a server restart does not itself disconnect Google.

## Confirmation click authorization fails open without identity

- **What:** isConfirmationClickAuthorized returns true if SeaTalk supplies no comparable
  clicker identity. Clarification and Sheet-update clicks fail closed; Sheet-update authorization
  requires the PIC email.
- **Why:** Changing one predicate without considering stale/missing SeaTalk clicker fields can
  alter who may confirm tasks.
- **Where:** src/confirmation-auth.js.
- **Do:** Preserve this distinction deliberately and test known, unknown, and mismatched identities.

## PIC receipt is an explicit task acknowledgement

- **What:** Sending the assignment card leaves a new task in TODO. Only a click whose email equals
  the PIC email in the Sheet row can change TODO to IN PROGRESS.
- **Why:** Delivery of a DM does not establish that the PIC accepted the task. The callback must
  re-read the Sheet row so it still works after process-local task state is lost on restart.
- **Where:** src/task-acknowledgement.js, src/confirmation-auth.js, and server.js handleWebhook.
- **Do:** Keep the acknowledgement check fail-closed, refresh UpdatedAt only on TODO → IN PROGRESS,
  preserve the rest of the row, and leave DONE/NOT DO/IN PROGRESS unchanged on repeated clicks.

## Sheet IDs and deduplication are process-local assumptions

- **What:** nextTaskId reads max(ID)+1, then appendTask writes under appendQueue. Event
  deduplication searches only the retained messages array; a duplicate is retried only when
  the saved record has sheet.status=failed and writes are enabled.
- **Why:** appendQueue protects one GoogleSheetsClient instance, not multiple server processes.
  Once an event record is evicted from the 100-message array, the same event may be processed
  again without the duplicate-retry check.
- **Where:** src/google-sheets.js appendQueue/nextTaskId/appendTask; server.js addMessage and
  handleWebhook.
- **Do:** Do not claim multi-instance-safe IDs or durable idempotency.

## Priority policy and deterministic inference can diverge

- **What:** TASK_PRIORITY_POLICY.md says an explicit label wins over urgency. extractLabeledFields
  can preserve a labeled Priority field, but inferPriorityFromText scans P2/normal first,
  then P0/urgent, then P1/important. A conflicting unlabeled token and urgency can resolve
  according to this scan order rather than the policy precedence.
- **Why:** A behavior change could silently affect the rules-only baseline and disagree with
  the LLM prompt's policy.
- **Where:** src/task-extractor.js extractLabeledFields, inferPriorityFromText, and createTaskExtractor.
- **Do:** Add conflicting-signal fixtures and align rule, code, few-shot examples, and tests before
  changing priority resolution.

## Task-name matching is not wired into server routing

- **What:** detectTaskIntent can return query text and GoogleSheetsClient has findTasksByText,
  but processSheetTaskUpdate requires taskId and returns task_id_required when a query has no ID.
- **Why:** Describing “update a task by name” as an operational flow would promise behavior
  that the current server orchestration does not use.
- **Where:** src/sheet-task-updates.js detectTaskIntent/findMatchingSheetTasks;
  src/google-sheets.js findTasksByText; server.js processSheetTaskUpdate.
- **Do:** Use a Sheet Task ID or quote a remembered task message. Treat name-based lookup as
  unimplemented until the server calls the matcher.

## Thread replies are selectively processed

- **What:** shouldProcessMessage accepts new_message_received_from_thread only when it has a
  quotedMessageId or detectTaskIntent recognizes an update.
- **Why:** A plain reply may appear in the dashboard but will not run extraction.
- **Where:** server.js shouldProcessMessage.
- **Do:** Preserve this filter when changing thread behavior; update tests/flow documentation
  if the accepted message set changes.

## Rule markdown is only loaded at module import

- **What:** The three rules are synchronously read once and placed in EXTRACTION_PROMPT.
- **Why:** Editing a rule does not update an already-running process; deterministic parsing is
  also implemented separately in code.
- **Where:** src/task-extractor.js readRuleFile/createTaskExtractor.
- **Do:** Restart the server and keep rule text, code, prompt examples, fixtures, and tests aligned.

## Identity changes after a task is written

- **What:** An unwritten draft is editable by its creator identity (email, employee_code, or
  SeaTalk ID). Once written, PIC and Creator emails may edit Priority, Deadline, and Status.
  A blank Creator cell on a Sheet row leaves permission with the PIC only. Changing PIC through
  chat is unsupported.
- **Why:** The written-task Creator comes from column I and must survive whole-row updates; an
  omitted Creator value must not erase it. Card-confirmed Creator edits must notify the PIC.
- **Where:** src/confirmation-auth.js and server.js processTask/processSheetTaskUpdateById.
- **Do:** Cover creator, PIC, missing identity, legacy blank Creator, mismatch, row preservation,
  and PIC notification routing in tests. Add the live sheet's `Creator` header manually in I1.

## Keep local credentials out of Git and output

- **What:** .gitignore excludes .env and .oauth/. GoogleSheetsClient stores tokens under
  .oauth/google-token.json by default.
- **Why:** These files contain secrets or access tokens.
- **Where:** .gitignore and src/google-sheets.js token methods.
- **Do:** Read .env.example for variable names; never print, stage, or commit the actual files.

## README contains a checkout-specific path

- **What:** The local quick-start example points to C:\_Code\craftland\AlphaIntel, which is not
  this checkout path.
- **Why:** Copying it literally can send a developer to a nonexistent directory.
- **Where:** README.md under “Chạy local”.
- **Do:** Treat the README path as an example/spec, not a portable path. This doc-only task
  intentionally left README unchanged.
