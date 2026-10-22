# Codex prompt — generate agent/index docs for this repo

Usage: from the repo root run `codex` and paste everything below the line (or `codex exec "$(cat docs/codex-prompt-agent-docs.md)"`).
Codex should only create/modify the documentation files listed in the prompt, never source code.
When finished, Codex makes **one local commit on `master`** (no branch, no push) following the Git workflow defined in this prompt; that same workflow is then written into `AGENTS.md` so every future implementation task is committed the same way.

---

## ROLE

You are a senior engineer writing onboarding documentation for **AI coding agents** (OpenAI Codex and Anthropic Claude Code) that will work on this repository. Goal: an agent that opens this repo cold should understand what the project does, where everything lives, how to run/test it, and which traps to avoid, in under 2 minutes of reading and without having to grep the whole codebase.

## HARD RULES

1. **Documentation only.** Create or edit only the files listed under DELIVERABLES. Do not touch `server.js`, `src/**`, `public/**`, `rules/**`, `test/**`, `package.json`, `.env.example`, or `README.md`.
2. **Verify every claim against the source.** The "Seed notes" below are a hand-written head start, not ground truth. Read the code and confirm each fact before writing it. If a seed note is wrong or stale, use what the code says and list the discrepancy in your final report. If you cannot verify something, omit it or mark it `(unverified)`.
3. **No invented content.** Never fabricate env vars, endpoints, commands, function names, or behaviours. Use exact identifiers as they appear in code. Reference code as `path:line` only when you just looked it up; otherwise reference by function name (line numbers rot).
4. **Never read, print, or copy secrets.** Do not open `.env` or `.oauth/`. Use `.env.example` only.
5. **Single source of truth.** Detail lives in `docs/`; `AGENTS.md` summarises and links. Do not duplicate long content across files. `CLAUDE.md` must not repeat `AGENTS.md`; it imports it.
6. **Be terse.** Prefer tables, bullet lists, and short code blocks over prose. No marketing language, no restating what is obvious from file names.
7. Write docs in **English**, but keep Vietnamese domain terms and user-facing strings verbatim where they matter (e.g. `tuần sau`, `Confirm`, status values), with an English gloss on first use. This repo's runtime messages, rules, and README are Vietnamese.
8. Run `npm test` before and after. It must still pass (baseline: 51 tests pass, 0 fail, Node 18+; the dev machine uses Node 24). Also run `node test/eval-extract --provider rules` (baseline: 46/46 on deadline, priority, task). Report both results.
9. **Git rules for this task** are the ones in the section "GIT WORKFLOW & COMMIT CONVENTION" below. In short: stay on `master`, never create or switch branches, never push, commit once at the end with a Conventional Commits message.

## DELIVERABLES

Create exactly these files.

### 1. `AGENTS.md` (repo root) — the primary entry point, ≤ 170 lines
Codex reads this automatically; Claude Code reads it through `CLAUDE.md`. Sections, in order:
- **What this is** — 3–4 lines.
- **Quick start** — install/run/dev/test/eval commands copied from `package.json` scripts (verify they exist), required Node version, how to run without any external credentials (rules-only extractor, `POST /api/test-message`).
- **Repo map** — a table: path → one-line responsibility, with approximate size for the big files (`server.js`, `src/task-extractor.js`).
- **Architecture in 10 lines** — pipeline from SeaTalk webhook → parse → route → extract → confirmation card → Google Sheet → DM to PIC. Link to `docs/architecture.md` for detail.
- **Conventions** — ESM (`"type": "module"`), zero runtime dependencies, `node:test` for tests, Conventional Commits (check `git log` for the actual prefixes used), how tests inject fakes (look at how tests mock `fetch` / `fetchImpl`), code-comment and naming style actually used in the repo.
- **Always / Never** — hard rules for agents (see "Gotchas" below; promote only the high-impact ones here).
- **Git workflow & commit convention** (≤ 30 lines, REQUIRED, placed right after "Always / Never") — a condensed, imperative version of the "GIT WORKFLOW & COMMIT CONVENTION" section of this prompt: work on `master` only, commit automatically after each completed implementation (tests green), never push, Conventional Commits 1.0.0 header format, the allowed type/scope lists, the repo-specific definition of a breaking change, and the pre-commit checklist. End with a link to `docs/git-workflow.md` for the full version. This section must be phrased as instructions to the agent ("After finishing an implementation, commit…"), not as a description.
- **Where to look when…** — a task-oriented lookup table (e.g. "change how deadlines are parsed" → `rules/DEADLINE_POLICY.md` + `normalizeDeadline` in `src/task-extractor.js` + fixtures + tests).
- **Doc index** — links to every file under `docs/` with a one-line description.

### 2. `CLAUDE.md` (repo root) — ≤ 30 lines
First line: `@AGENTS.md` (Claude Code import syntax). Then only Claude-specific additions that do not belong in AGENTS.md, for example: prefer dedicated Read/Grep tools, ask before running anything that hits external services, never run the server with real credentials unless asked. If you have nothing Claude-specific worth saying, keep the file to the import plus 3–5 lines. Do not restate the Git workflow here; it arrives through the import.

### 3. `docs/INDEX.md` — navigation hub
A table of every doc and source module: purpose, when to read it, key exports/entry points. Include a "reading order for a new agent" (numbered, ≤ 6 items) and a glossary of project terms (PIC, draft, thread session, clarification, quote/quoted message, Sheet Task ID vs `shortId`, `employee_code`, reference date, `skipSheet`, P0/P1/P2, confirmation card, assignment notification).

### 4. `docs/architecture.md`
- Component diagram as a **Mermaid** flowchart (SeaTalk → `/callback` → `handleWebhook` → … → Google Sheets / SeaTalk API; dashboard via SSE).
- Module responsibilities and dependency direction (which `src/*` modules import which; `server.js` is the orchestrator and holds all state).
- The in-memory state maps in `server.js` (`messages`, `clients`, `oauthStates`, `threadSessions`, `confirmationDrafts`, `sheetUpdateDrafts`, `sheetMessageReferences`): what each is keyed by, what it holds, when entries are created/deleted, size limits, and the consequences of a restart.
- Concurrency model: the per-task promise guards (`confirmPromise`, `fieldUpdatePromise`, `clarification.promise`, `pending.confirmPromise`) and the `appendQueue` in `GoogleSheetsClient`. Explain what race each one prevents.
- Fire-and-forget pattern (`void processTask(...)`) and what that implies for error handling.

### 5. `docs/flows.md`
One subsection per flow, each with a Mermaid `sequenceDiagram` or numbered steps naming the exact functions involved, the `record.processing` status values touched (`extraction.status`, `sheet.status`, `confirmation.status`), and the failure branches:
1. SeaTalk `event_verification` handshake and signature check (`signaturesMatch`).
2. New task from a group-thread @mention → extraction → confirmation card + thread reply → Confirm click → Sheet append → PIC DM → card rewritten as confirmed.
3. Revising a draft (reply in same thread, quoted message, priority/deadline quick-pick buttons → `redrawConfirmationCard`, fallback resend).
4. Ambiguity → clarification card (`resolveTaskRoute` → `clarify`, new vs target buttons, 5-task cap).
5. Re-confirming an already-written task (`reopenTaskForConfirmation`, updates the same row instead of appending).
6. Phase 2: updating an existing Sheet task by natural language / quoted message (`detectTaskIntent`, `processSheetTaskUpdate*`, status-only fast path `updateSheetStatusImmediately` vs card + `confirmSheetUpdate`).
7. Google OAuth connect/disconnect and token storage.
8. Dashboard: `/api/stream` SSE snapshot + `message` / `processing` / `clear` packets, how `public/app.js` consumes them.
Also tabulate the **button-value grammar** parsed by `parseConfirmationButtonValue` (every `task:…` value shape, which handler consumes it).

### 6. `docs/extraction.md`
How the task extractor works and how to change it safely:
- Providers (`auto | chatflow | compass | rules`), selection logic in `providerName()`, what `configured` means.
- Pipeline inside `createTaskExtractor().extract`: rules fallback, payload hints, LLM call, `parseTaskFields`, `mergeFields` precedence, `mergeRevisionFields` (only fields with an explicit revision signal change), `finalizeFields` defaults, `cleanTaskContent`.
- Precedence rules as a table: code-computed deadline > model deadline; explicit priority label > urgency word > derived from deadline > default P2; etc. — taken from code, cross-checked with `rules/*.md`.
- How `rules/*.md` are loaded (read once at import, injected into `EXTRACTION_PROMPT`, restart required) and the **three-way sync** an agent must maintain when changing behaviour: rule `.md` ⇄ code ⇄ `test/fixtures/extraction-cases.json` + tests + prompt few-shot table.
- Reference date and timezone (`Asia/Ho_Chi_Minh`), `HOLIDAY_DATES`, working-day logic.
- How to run and read `npm run eval:extract` (flags `--provider`, `--reference-date`, `--details`) and how to add a fixture case.

### 7. `docs/integrations-and-config.md`
- Every environment variable from `.env.example` in a table: name, default, required?, used by, effect. Group by SeaTalk / Chatflow / Compass / Google / server. Cross-check with the `process.env.*` reads in `server.js`.
- HTTP endpoint table (method, path, purpose, auth) from the `createServer` handler in `server.js`, including webhook aliases. Note the CORS `*` header and that dashboard endpoints are unauthenticated.
- SeaTalk Open Platform calls used (`/auth/app_access_token`, `/messaging/v2/single_chat`, `/messaging/v2/group_chat`, `/messaging/v2/update`), token caching, message card shapes built in `src/seatalk.js`, and the group-chat limitation (interactive cards cannot be posted in groups, hence the DM-card + thread-text design — confirm in README and code).
- Google Sheets: A–H column contract, header assumed on row 1 (data from row 2), ID = `max(ID)+1`, `USER_ENTERED`, OAuth scopes, token file path, write flag `GOOGLE_SHEETS_WRITE_ENABLED`.

### 8. `docs/testing.md`
- How to run all tests / a single file / a single test name; test layout and what each test file covers; the fixture format; how fakes are injected; what is **not** covered (state which parts of `server.js` have no tests — verify by grepping imports in `test/`).
- Checklist of "if you change X, also run/update Y".

### 9. `docs/gotchas.md`
A curated list of non-obvious traps, each with: what, why it matters, where in code, and what to do. Start from the seed list below, verify each, and add anything else you find. Order by blast radius.

### 10. `docs/git-workflow.md` — full Git workflow & commit convention
The complete, authoritative version of the section "GIT WORKFLOW & COMMIT CONVENTION" below, reorganised for lookup: branch policy, when to commit, pre-commit checklist, message format, type table with repo-specific examples, scope table, breaking-change definition for this repo, body/footer rules, splitting rules, forbidden operations, and 8–10 good/bad message examples. Examples must be realistic for this codebase (SeaTalk cards, Sheet columns, deadline parsing, etc.). Also include a "Quick recipe" of the exact commands (stage by path → inspect → commit → verify). Link it from `docs/INDEX.md` and from `AGENTS.md`.

### 11. Nested agent files (short, ≤ 40 lines each)
For `src/`, `rules/`, and `test/`: an `AGENTS.md` with local conventions and the specific invariants of that directory, plus a sibling `CLAUDE.md` containing only `@AGENTS.md`. Do not repeat the root file.

## SEED NOTES (verify before using — these come from a first read of the code)

**Project**: "Alpha Intel · SeaTalk inbox" — a dependency-free Node.js (ESM) HTTP server (`server.js`, ~1,430 lines) that receives SeaTalk Open Platform bot callbacks (`POST /callback`, aliases `/seatalk/callback`, `/webhook/seatalk`), extracts a task (PIC email, content, deadline `DD/MM/YYYY`, priority P0/P1/P2, status) from Vietnamese chat messages using an LLM (Chatflow or Compass) with a deterministic rules fallback, asks the creator to confirm via SeaTalk interactive card, then writes to a Google Sheet (columns A–H: ID, Task, PIC, Deadline, Priority, Status, CreatedAt, UpdatedAt) and DMs the PIC. A static dashboard (`public/`) shows events live over SSE. Port 3030 by default.

**Layout**: `server.js` (orchestrator + all state + HTTP routing); `src/task-extractor.js` (~860 lines: prompt, date parsing, hints, providers); `src/seatalk.js` (API client + card builders); `src/google-sheets.js` (OAuth + Sheets REST via `fetch`); `src/thread-sessions.js` (pure in-memory session/task model and routing); `src/confirmation-auth.js` (who may click/update); `src/confirmation-routing.js` (button-value parser); `src/sheet-task-updates.js` (Vietnamese intent detection for updating existing Sheet rows, row→task mapping, fuzzy match); `rules/*.md` (PIC, deadline, priority policies injected into the LLM prompt); `public/{index.html,app.js,styles.css}` (dashboard); `test/*.test.js` + `test/eval-extract` + `test/fixtures/extraction-cases.json`; `bot-chat-flow.{svg,png}` (diagram of the chat flow — look at it and reference it from `docs/flows.md`).

**Scripts** (`package.json`): `start` = `node server.js`, `dev` = `node --watch server.js`, `test` = `node --test`, `eval:extract` = `node test/eval-extract`.

**Candidate gotchas to verify**
- All state is in memory (messages capped at 100, thread sessions, drafts, OAuth states). Restart loses pending confirmations; cards already sent in SeaTalk then reference drafts that no longer exist (`"Draft xác nhận không còn tồn tại…"`).
- `isConfirmationClickAuthorized` deliberately **fails open** when SeaTalk omits clicker identity, whereas `isClarificationClickAuthorized` / `isSheetUpdateClickAuthorized` fail closed. Don't "fix" one without understanding the other.
- `normalizeEmail` is defined in both `server.js` and `src/confirmation-auth.js`; `addDays`/date helpers exist in both `src/seatalk.js` and `src/task-extractor.js`. Duplicated, not shared.
- `rules/*.md` are read once at module load; editing them requires a server restart, and tests assert on prompt contents.
- Deadline/priority behaviour is defined in **three** places that must stay consistent: rule markdown, code (`normalizeDeadline`, `resolvePriority`, `finalizeFields`), and the few-shot table in `EXTRACTION_PROMPT` plus `extraction-cases.json`. Fixtures are anchored to reference date `2026-10-22` (a Thursday).
- Code-computed deadline/priority override the model's output; the LLM is mostly used for `task` cleaning, PIC and `deadline_expression`.
- Sheet row lookup assumes a header in row 1 (`A2:H`, `rowNumber = index + 2`); `nextTaskId` is `max+1` read-then-append, safe only because writes are serialised through `appendQueue` in one process (not multi-instance safe).
- `void processTask(...)` is fire-and-forget; the webhook returns 200 immediately and failures surface only in `record.processing` and SSE.
- A duplicate webhook (same `event_id`/`message_id`) is deduped, except it is re-processed when the previous attempt's `sheet.status === "failed"` and writes are enabled.
- Thread messages of type `new_message_received_from_thread` are processed only if they quote a message or match an update intent (`shouldProcessMessage`).
- Only the original creator may edit an unwritten draft; after the task is written only the PIC (compared by email) may update it (`isTaskMessageUpdateAuthorized`, `isSheetRowUpdateAuthorized`). PIC changes via chat are explicitly unsupported ("Phase 2").
- `GOOGLE_SHEETS_WRITE_ENABLED` defaults to false; with it false, Confirm is acknowledged but nothing is written.
- Dashboard API endpoints (`/api/messages`, `DELETE /api/messages`, `/api/test-message`, `/api/google/disconnect`) are unauthenticated with `Access-Control-Allow-Origin: *`; the server binds `0.0.0.0` by default. Flag as a deployment risk, do not change.
- `.env`, `.oauth/google-token.json` are git-ignored and must never be committed or printed.
- `README.md` is Vietnamese and contains an outdated local path (`C:\_Code\craftland\AlphaIntel`); treat it as functional spec, not as a path reference.
- User-facing bot strings are Vietnamese; keep that language when editing them.

## GIT WORKFLOW & COMMIT CONVENTION

This section is a binding policy for this task **and** the content you must encode into `AGENTS.md` (condensed) and `docs/git-workflow.md` (full) so that every future implementation by Codex or any other agent follows it automatically. The commit message format is [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/); re-read that page if you need to confirm a rule.

### A. Branch policy — `master` only
- All work is done **directly on `master`**. Do not create, rename, switch to, or delete any branch. Forbidden: `git checkout -b`, `git switch -c`, `git branch <name>`, `git worktree add`, `git stash branch`, feature/fix/docs branches of any kind.
- Before starting any task run `git branch --show-current`. If it is not `master`, **stop and ask the user**; do not switch on your own, and do not carry uncommitted work across branches.
- Do not open PRs or merge anything. There is no branching workflow in this repo from now on.

### B. Commit automatically, never push
- When an implementation task is complete (code written, `npm test` green, and `node test/eval-extract --provider rules` not regressed when extraction logic, `rules/*.md`, or fixtures changed), **create a commit without waiting to be asked**. Docs-only tasks are committed too.
- If tests fail, do **not** commit. Fix the failure; if you cannot, leave the tree uncommitted and report the failing output verbatim.
- If the user only asks a question, a review, or a plan and no files changed, there is nothing to commit. Never create empty commits.
- **Never push.** Forbidden: `git push` in any form, `git remote add/set-url`, `git fetch`/`pull` unless the user asks, `--force`, `--force-with-lease`. Never configure upstream tracking. The commit stays local; the user decides when to push.
- Never: `--amend`, `rebase`, `reset --hard`, `commit --no-verify`, `commit --no-gpg-sign`, `git clean -f`, `git config` changes (use the already-configured `user.name`/`user.email`). Do not bypass hooks; if a hook fails, fix the cause and make a **new** commit. Amend or rewrite history only if the user explicitly asks.
- Do not add `Co-authored-by` or "generated by" trailers unless the user asks for them.

### C. Pre-commit checklist (run in order)
1. `git status --short` — list what changed. If the tree was already dirty **before** you started, those pre-existing changes are the user's: do not stage or commit them; mention them in your report.
2. Stage **explicitly by path** (`git add path1 path2`). Never `git add -A`, `git add .`, or `git commit -a`.
3. `git diff --cached --stat` and skim `git diff --cached` — confirm only intended files are staged, no debug leftovers, and **no secrets**. `.env`, `.oauth/`, tokens, and credentials must never be staged (they are in `.gitignore`; verify anyway).
4. Tests/eval as described in B.
5. Commit with the message format in D. Use multiple `-m` flags or a message file/here-doc for multi-line messages.
6. `git log -1 --stat` — confirm the result, then report the short hash and the message, and state explicitly that nothing was pushed.

### D. Message format (Conventional Commits 1.0.0)

```
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

Rules taken from the spec, plus repo-specific style (observed in `git log`: `feat(deadline): …`, `fix(extractor): …`, `test(extractor): …`, `chore: …`):
- Header = type, optional `(scope)`, optional `!`, colon, single space, description. Required.
- **Description**: imperative mood ("add", "fix", "prevent"), lower-case first letter, no trailing period, English, ideally ≤ 72 characters. Say *what changed in behaviour*, not "update code".
- **Body**: optional; starts after one blank line; free-form paragraphs wrapped at ~72 columns. Use it to explain **why** and any non-obvious trade-off, not to re-list the diff.
- **Footers**: after one blank line; `Token: value` or `Token #value`; tokens use `-` instead of spaces (e.g. `Refs: #12`, `Reviewed-by: …`). Exception: `BREAKING CHANGE`.
- Types are case-insensitive per spec but **always write them lower-case**; `BREAKING CHANGE` must be upper-case.
- One logical change per commit. If a change fits more than one type, **split it into several commits** (e.g. `feat(...)` for code, then `test(...)` for extra fixtures, then `docs(...)`), each of which leaves tests green when possible. Tests that belong to a feature may ship in the same commit as the feature.

**Allowed types** (use only these):

| Type | Use for | SemVer |
|---|---|---|
| `feat` | New user-visible capability (new bot behaviour, endpoint, env var, card, parsed expression) | MINOR |
| `fix` | Bug fix (wrong deadline/priority/PIC, race condition, bad card, Sheet write error) | PATCH |
| `docs` | Documentation only (`README.md`, `AGENTS.md`, `docs/**`, code comments) | — |
| `test` | Tests, fixtures, eval script only | — |
| `refactor` | Behaviour-preserving restructuring | — |
| `perf` | Performance improvement | — |
| `style` | Formatting/whitespace only, no logic | — |
| `build` | `package.json`, scripts, Node version, dependencies | — |
| `ci` | CI configuration | — |
| `chore` | Maintenance not covered above (rule-file wording that doesn't change behaviour, `.gitignore`, `.env.example` comments) | — |
| `revert` | Reverting a commit — only when the user asks; body: `This reverts commit <full-sha>.` | — |

A change to `rules/*.md` that alters extraction behaviour is `feat` or `fix` (scope `deadline`, `priority`, or `pic`), **not** `chore`/`docs`.

**Scopes** (optional; a noun for the area touched; pick from this list, add a new noun only when none fits, and reuse it afterwards):
`extractor`, `deadline`, `priority`, `pic`, `prompt`, `seatalk`, `card`, `sheets`, `sheet-update`, `thread`, `auth`, `routing`, `server`, `dashboard`, `config`, `eval`, `rules`, `deps`.
Omit the scope when a change spans several areas or is repo-wide.

**Breaking changes** (mark with `!` after type/scope **and/or** a `BREAKING CHANGE: <what breaks and how to migrate>` footer). In this repo a change is breaking if it:
- alters the Google Sheet column contract (A–H order, meaning, or the ID scheme) or the expected header row,
- changes the button-value grammar parsed by `parseConfirmationButtonValue` so cards already sent to users stop working,
- renames/removes an environment variable or changes its default in a way that alters runtime behaviour,
- removes or changes the meaning of an HTTP endpoint or webhook alias,
- changes who is authorised to confirm/update a task.
Pure deployment-risk notes are not breaking changes.

**Examples**

```
feat(deadline): parse "cuối ngày" and "EOD" as today

fix(sheet-update): reject status updates from non-PIC senders

fix(extractor): keep draft fields when only priority is revised

test(extractor): add fixtures for week-relative deadlines

docs: add agent index and git workflow

refactor(thread): extract quoted-message lookup into helper

feat(sheets)!: add Owner column after PIC

BREAKING CHANGE: the Sheet now has nine columns (A:I). Existing sheets
must insert a new column C and set GOOGLE_SHEETS_RANGE=A:I.
```

Bad (never write): `update code`, `Fix bug.`, `WIP`, `Feat: Add stuff`, `fixed things and added tests and docs`, `feature/login: …`, a header with no colon, or a message that mixes unrelated changes.

### E. What to do when unsure
- Cannot decide the type → choose the one describing the **primary user-visible effect**; if truly mixed, split the commit.
- Working tree contains changes you did not make → leave them out and tell the user.
- Hook or test failure you cannot resolve → do not commit, report verbatim.

## PROCESS

1. Run `git branch --show-current` and `git status --short`. Must be on `master`; record any pre-existing uncommitted changes (do not touch them). Then read: `README.md`, `package.json`, `.env.example`, `rules/*.md`, then `server.js` top to bottom, then each `src/*.js`, then skim `test/*.test.js`, `public/app.js`, and `git log --oneline`.
2. Run the baseline commands (rule 8) and note results.
3. Draft all deliverables. After drafting, re-open the source for every function name, env var, endpoint, and status string you cited and confirm it exists with that exact spelling.
4. Validate: every relative link in every new file resolves to an existing file (script this check); every Mermaid block is syntactically valid (keep diagrams small enough to render); `AGENTS.md` ≤ 170 lines and `CLAUDE.md` ≤ 30 lines; `AGENTS.md` contains the Git workflow section and `docs/git-workflow.md` exists and is linked from `AGENTS.md` and `docs/INDEX.md`; no secrets anywhere.
5. Re-run `npm test` and `node test/eval-extract --provider rules`; confirm `git status` shows only new/modified documentation files (plus any pre-existing changes you recorded in step 1, which you leave alone).
6. **Commit** following the Git workflow above, on `master`, **do not push**. Stage the documentation files explicitly by path. Use a single commit:
   ```
   docs: add agent index, architecture docs and git workflow

   Add AGENTS.md/CLAUDE.md entry points and docs/ (index, architecture,
   flows, extraction, integrations, testing, gotchas, git-workflow) so
   Codex and Claude Code can onboard quickly. Document the master-only
   branch policy and the Conventional Commits convention.
   ```
   (`docs/codex-prompt-agent-docs.md` itself may be included in this commit if it is untracked.)
7. Verify with `git log -1 --stat` and `git status --short`.

## FINAL REPORT (print this, don't write it to a file)

- List of files created with line counts.
- Test and eval results before/after.
- Git result: current branch (must be `master`), commit short hash + header, `git log -1 --stat`, and an explicit statement that nothing was pushed and no branch was created.
- Seed-note discrepancies (what the notes claimed vs. what the code says).
- Anything unverifiable, and any risk or bug you noticed but deliberately did not fix (file + one line each).
