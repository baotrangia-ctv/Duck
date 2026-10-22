# Runtime flows

These status names are the literal values written under record.processing. Not every event
touches all three status groups.

## 1. SeaTalk verification and signature check

1. A POST to /callback, /seatalk/callback, or /webhook/seatalk enters handleWebhook.
2. readRequestBody rejects bodies over 1,000,000 bytes with HTTP 413; malformed JSON returns 400.
3. For non-verification events, signaturesMatch checks the Signature header when
   SEATALK_SIGNING_SECRET is set: SHA-256 of the raw request bytes followed by the
   secret encoded as Latin-1, compared with the lower-case hex Signature using a
   timing-safe comparison. Missing or invalid signatures return HTTP 401.
4. event_verification bypasses signature validation, is recorded with addMessage, and returns
   payload.event with HTTP 200. For ordinary events, addMessage records/deduplicates and
   the response is HTTP 200 with ok, received, and deduped.

No task extraction status is created for verification events.

## 2. New task → card → Confirm → Sheet → PIC acknowledgement

1. parseSeaTalkEvent normalizes a supported message event. shouldProcessMessage accepts it;
   processTask gets a thread session and calls resolveTaskRoute. An empty session routes new.
2. createNewTask makes draftId and shortId; processTaskForTask calls taskExtractor.extract.
   extraction.status moves to extracting (or rules) then complete, or failed. sheet.status
   starts at awaiting_confirmation.
3. draftFromFields and updateTaskFromDraft store the draft. sendConfirmationCard registers
   the callback and sends buildConfirmationMessage through seatalk.sendReply. For a group
   target, sendReply uses sendGroupChat and includes thread_id; a direct target uses
   sendSingleChat. confirmation.status is sending then sent, or not_configured/failed.
4. The interactive callback is parsed by parseConfirmationButtonValue and dispatched by
   handleWebhook to confirmTask. confirmTask checks the pending draft and confirmTaskInternal
   checks identity, PIC/deadline/task presence, the write flag, configuration, and OAuth.
5. Missing fields give sheet.status=missing_required_fields and confirmation.status=needs_revision.
   A disabled write flag gives paused/blocked; missing configuration or authorization gives
   not_configured/auth_required and blocked. These branches do not write a row.
6. On success, sheet.status moves to writing then written; confirmation.status moves to
   writing then confirmed. GoogleSheetsClient.appendTask allocates the Sheet Task ID and a row
   whose default status is TODO. sendTaskAssignmentNotification sends the PIC an interactive
   card with task:ack:<sheetTaskId>; updateConfirmationCardAfterConfirm replaces the creator's
   confirmation card with its completed shape. Card send/update failures are kept in
   confirmation.error after the Sheet write succeeds. Sheet write failure sets sheet/confirmation
   to failed.
7. The PIC card's button is a separate acknowledgement. handleTaskAcknowledgement re-reads the
   Sheet row by ID, requires the clicker's email to equal that row's PIC email, and checks the
   write flag plus Sheets configuration and authorization. Only TODO changes to IN PROGRESS;
   the write refreshes UpdatedAt and preserves all other columns. A repeated click or a row already
   in IN PROGRESS, DONE, or NOT DO does not write or downgrade the row. The card is replaced by a
   no-button state and the outcome is recorded with updateProcessing. Re-reading the row lets this
   work after a server restart.

The current source sends the interactive card to the source target; it does not implement the
README-described DM-card plus thread-text fallback. See [gotchas](gotchas.md).

## 3. Revising a draft

1. A thread message can find a task through quotedMessageId or resolveTaskRoute. An unwritten
   task may be revised only by its creator identity; processTaskForTask passes existing fields
   and up to six recent message-history entries as extractor context.
2. mergeRevisionFields changes only fields with an explicit revision signal. A reply without
   an explicit task quote can instead route to clarification when a session already has tasks.
3. After extraction, redrawConfirmationCard calls /messaging/v2/update with the existing
   message_id. On update failure or missing card identity, it logs and calls sendConfirmationCard
   to resend. extraction.status becomes complete; confirmation.status is sent or sending/failed.
4. Priority and deadline quick-pick buttons use updateDraftFieldAndRedraw; the same card is
   redrawn. A successful field edit leaves confirmation.status=sent.

## 4. Ambiguity and clarification

1. resolveTaskRoute returns new when the session has no tasks; otherwise an unquoted message
   routes clarify. processTask creates a pending clarification tied to the original sender.
2. sendClarificationCard displays up to five recent tasks and a new-task choice. The card has
   at most six buttons: one new choice and five task choices, grouped at no more than three
   buttons per group.
3. confirmation.status becomes clarifying then clarification_sent; send/config failures set
   not_configured or failed. Extraction is not run until a choice is clicked.
4. handleClarification authorizes the original sender, then creates a new task or routes to the
   selected shortId and calls processTaskForTask. clarification.promise deduplicates concurrent
   clicks; the pending choice is deleted after handling.

## 5. Updating a task already written

1. A quoted task message is resolved from the in-memory session. The PIC or Creator may request
   a change; processTask routes the request through requireReferencedSheetTaskUpdate.
2. processSheetTaskUpdateById re-reads the row, checks the row's PIC/Creator emails, and builds
   an update card or immediately applies a status-only change. An empty Creator cell allows only
   the PIC.
3. Confirm updates the existing row with updateTask, preserving the same Sheet row and ID.
   Column I's Creator value is carried through the write; if it is absent from update fields,
   GoogleSheetsClient reads the current cell before writing.
4. Card-confirmed edits attempt to DM the PIC. If the PIC employee code is unavailable, the
   Sheet update still succeeds and the notification error is recorded.

## 6. Phase 2: updating an existing Sheet task

1. detectTaskIntent recognizes update language and fields. A Sheet Task ID is parsed from text;
   a quoted SeaTalk assignment/update message can resolve through sheetMessageReferences.
2. processSheetTaskUpdate requires a task ID or quote. The helper can produce a task-name query,
   but current server orchestration does not use findTasksByText to resolve that query.
3. processSheetTaskUpdateById checks GOOGLE_SHEETS_WRITE_ENABLED, Sheets OAuth, row existence,
   and PIC or Creator email authorization. A blank Creator cell means only the PIC is authorized.
   It applies requested priority/deadline/status.
4. Status-only requests take updateSheetStatusImmediately: sheet.status writing → updated and
   confirmation.status updating → updated; a text reply is sent. Failures set failed.
5. Other requests send a card via sendSheetUpdateCard. Quick picks use updateSheetUpdateDraft;
   Confirm uses confirmSheetUpdate, writes the same row with updateTask, attempts a PIC DM,
   and rewrites the card. Statuses include awaiting_update_confirmation, writing, updated,
   sent, and failed. Card/notification errors after the row update are recorded in
   confirmation.error without changing the successful Sheet update.
6. PIC changes are explicitly unsupported and return a Phase 2 response.

Creator is stored as a lowercase email in column I and is carried through whole-row updates.
The live sheet's `Creator` header in I1 must be added manually. Card-confirmed Creator edits
notify the PIC by employee code; if that code is unknown, the update is saved and the notification
error is recorded instead of messaging the Creator.

## 7. Google OAuth connect/disconnect

1. GET /auth/google calls startGoogleAuthorization. If configured, it creates a random state
   expiring in ten minutes and redirects to Google's authorization URL with spreadsheet, openid,
   email, and profile scopes.
2. GET /auth/google/callback consumes the state and code. A provider error redirects as
   cancelled; missing, invalid, or expired state/code returns HTTP 400. A valid code calls
   authorizeWithCode, fetches account email, and saves tokens at GOOGLE_OAUTH_TOKEN_PATH.
3. Access tokens are refreshed with the stored refresh token. POST /api/google/disconnect
   clears the token object and deletes the local token file.

## 8. Dashboard and SSE

1. GET /api/stream calls handleStream, registers the response in clients, and immediately sends
   a snapshot packet containing messages.
2. addMessage broadcasts message packets. updateProcessing broadcasts processing packets with
   record id and processing state. DELETE /api/messages broadcasts clear.
3. public/app.js handles snapshot by replacing state.messages; message prepends/caps at 100;
   processing replaces the matching record's processing object; clear empties the display.
   On stream error it reconnects after 2.5 seconds and receives a new snapshot.

## Confirmation button-value grammar

parseConfirmationButtonValue accepts these shapes. Values not emitted by the current card
builder can still parse if their shape is valid; handlers may validate them further.

| Value shape | Parsed action | Handler / use |
|---|---|---|
| task:confirm:<draftId> | confirm | confirmTask |
| task:confirmed:<draftId> | confirmed | Display-only completed card; no callback handler |
| task:ack:<sheetTaskId> | task_ack | acknowledgeTask; reads and updates the PIC's Sheet row |
| task:priority:<draftId>:P0\|P1\|P2 | priority | updateDraftFieldAndRedraw |
| task:deadline:<draftId>:<value> | deadline | updateDraftFieldAndRedraw; resolveDeadlineQuickPick accepts today, tomorrow, weekend, +7d |
| task:clarify:<clarifyId>:new | clarify_new | handleClarification |
| task:clarify:<clarifyId>:target:<digits> | clarify_target | handleClarification using thread shortId |
| task:sheet-update:confirm:<updateId> | sheet_update_confirm | confirmSheetUpdate |
| task:sheet-update:updated:<updateId> | sheet_update_updated | Display-only completed card; no callback handler |
| task:sheet-update:priority:<updateId>:P0\|P1\|P2 | sheet_update_priority | updateSheetUpdateDraft |
| task:sheet-update:deadline:<updateId>:<value> | sheet_update_deadline | updateSheetUpdateDraft; quick-pick value is resolved by resolveDeadlineQuickPick |
