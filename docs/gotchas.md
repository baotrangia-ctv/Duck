# Gotchas

Ordered roughly by blast radius.

## Allowlist errors fail closed

- **What:** Missing or malformed `.auth/allowlist.json` denies access. After a valid config has
  loaded, an invalid edit keeps the last valid owner/viewer lists; deletion denies everyone.
- **Why:** Dashboard/API access must not become public when the allowlist cannot be read.
- **Where:** src/allowlist.js and `AUTH_ALLOWLIST_PATH`.
- **Do:** Copy `allowlist.example.json` to `.auth/allowlist.json`, keep valid JSON arrays for
  `owners` and `viewers`, then verify account changes take effect without restart.

## SeaTalk webhook stays public

- **What:** Dashboard authentication does not protect `/callback`, `/seatalk/callback`, or
  `/webhook/seatalk`. An empty `SEATALK_SIGNING_SECRET` accepts unsigned requests.
- **Why:** SeaTalk is server-to-server and does not send a browser session cookie.
- **Where:** server.js startup safety and handleWebhook/signaturesMatch.
- **Do:** Set `SEATALK_SIGNING_SECRET` before binding to a non-loopback host. The server refuses
  non-loopback startup when the secret is empty. `AUTH_DISABLED=true` is loopback-only too.

## Diagnosing missing SeaTalk events

- **What:** Runtime logs emit `SeaTalk webhook:` entries for accepted/verification events,
  missing/mismatched signatures, invalid JSON, and oversized bodies. Logs contain status,
  outcome, a bounded event type and processing/deduplication flags, never message text,
  email, raw payload or signature values.
- **Do:** If a new mention produces no entry, check SeaTalk Event Callback delivery history,
  published callback URL, event subscriptions and bot membership. If it produces 401, check
  the signing secret and delivery Signature header; keep signature verification enabled.
  Accepted events are stored even when extraction is filtered. Inbox state resets on deploy.

## Session continuity depends on its signing secret

- **What:** Dashboard sessions are signed cookies checked against the current allowlist on every
  request. Without an explicit secret, the server persists a generated key at `.auth/session-secret`.
- **Why:** The same key keeps sessions valid across restarts; changing or losing it invalidates
  every existing cookie.
- **Where:** src/session.js and `AUTH_SESSION_SECRET`.
- **Do:** Keep `.auth/` private and persistent. If you set `AUTH_SESSION_SECRET`, preserve the
  same value between restarts.

## Google login host and error diagnostics

- **What:** OAuth state uses a host-bound cookie and a signed ten-minute value. Open the app on
  the host and port in `GOOGLE_OAUTH_REDIRECT_URI`; `/auth/login` canonicalizes other hosts.
- **Why:** A callback on a different host cannot receive the state cookie. A changed session
  secret also invalidates a state already issued before restart.
- **Do:** Check `/login?error=<code>` and the matching `Google login:` server log line first.
  The code separates configuration, state, cookie, token, userinfo, verification, and allowlist
  failures without putting credentials in the redirect.

## Google reports redirect_uri_mismatch

- **What:** Google rejects the authorization request before the callback runs when the redirect
  URI does not exactly match an Authorized redirect URI.
- **Why:** Scheme, host, port, and path are compared exactly; the matching OAuth client must be
  type Web application.
- **Where:** The startup line `Google login: redirect URI sent to Google = ...` shows the value
  sent by this server.
- **Do:** Compare that value with the matching client's Authorized redirect URIs. Google's error
  page **error details** shows the exact `redirect_uri` received. After changing the URI in Cloud
  Console, allow a few minutes for the change to apply.

## Dashboard shows local@dev

- **What:** The dashboard is running with `AUTH_DISABLED=true`; requests are represented by the
  local owner `local@dev` without a Google session.
- **Why:** This bypass is intended only as a temporary escape hatch for automated local checks.
- **Do:** In PowerShell run `Remove-Item Env:AUTH_DISABLED -ErrorAction SilentlyContinue`, delete
  the `AUTH_DISABLED` line from `.env` if present without copying its value elsewhere, then restart
  the server.

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
- **Do:** Do not describe this as durable storage. The service-account key is stored outside
  Git, while access tokens are cached only in memory and fetched again after restart.

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
  quotedMessageId, detectTaskIntent recognizes an update, or parseReminderCommand matches a
  deadline-reminder command with IDs.
- **Why:** A plain reply may appear in the dashboard but will not run extraction.
- **Where:** server.js shouldProcessMessage.
- **Do:** Preserve this filter when changing thread behavior; update tests/flow documentation
  if the accepted message set changes.

## Reminder delivery depends on PIC employee-code resolution

- **What:** Column C stores an email, so reminders first use in-memory PIC codes and then a
  provisional SeaTalk contacts lookup, with positive email/code matches cached in memory.
- **Why:** After restart the memory shortcut is lost. The lookup POST path/body/response and
  exact app contacts permission have not been verified against the login-gated official docs.
- **Where:** src/seatalk.js getEmployeeCodeByEmail and server.js reminder resolver.
- **Do:** Verify the isolated contacts method against SeaTalk Open Platform before deployment.
  Faked HTTP tests do not establish live compatibility. A missing code skips that ID; API errors
  fail only that ID. Each task gets its own DM, and repeated commands send fresh reminders.

## Reminder deadlines and DONE clicks use current Sheet state

- **What:** Reminders skip DONE/NOT DO rows. Deadline text accepts dd/mm/yyyy, yyyy-mm-dd and
  dd/mm in the current Vietnam year. Invalid dates show `Chưa xác định Deadline`.
- **Why:** Day comparisons must use Asia/Ho_Chi_Minh calendar dates, including near midnight UTC.
  JavaScript date rollover must not turn an invalid date such as 31/02 into a valid deadline.
- **Where:** src/deadline-status.js, src/task-reminder.js, src/task-done.js.
- **Do:** Keep `task:done:<sheetTaskId>` additive and PIC-only. Re-read the row on each click;
  compare the current status before setting DONE and UpdatedAt. Concurrent clicks are serialized
  per task in this process. External Sheet edits are not covered by a distributed lock.
  `skipSheet` reminder demos must not read Sheets or send any message.

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

## Service account needs explicit Sheet sharing

- **What:** The service-account key defaults to `.auth/google-service-account.json`; Google
  Sheets does not grant that account access to a spreadsheet automatically.
- **Why:** A valid service-account token can still receive HTTP 403 until the Sheet is shared.
- **Where:** src/google-service-account.js, src/google-sheets.js, and
  `GET /api/google/status`.
- **Do:** Share the Sheet with the key's `client_email` as Editor. Keep `.auth/`, `.env`, and
  service-account keys out of Git and output; use `.env.example` for variable names.

## README contains a checkout-specific path

- **What:** The local quick-start example points to C:\_Code\craftland\AlphaIntel, which is not
  this checkout path.
- **Why:** Copying it literally can send a developer to a nonexistent directory.
- **Where:** README.md under “Chạy local”.
- **Do:** Treat the README path as an example, not a portable path; use your current repository
  root instead.
