# Git workflow and commit convention

This workflow is binding for repository changes. Work directly on master and leave the commit
local; the user decides when to push.

## Branch policy

- Before starting, run git branch --show-current and git status --short.
- Work directly on master. If the current branch is not master, stop and ask; do not switch.
- Never create, rename, or delete a branch. Do not use git checkout -b, git switch -c,
  git branch <name>, git worktree add, or git stash branch.
- Do not open PRs or merge changes. Do not push, set remotes/upstream, fetch, or pull unless
  the user explicitly asks.

## When to commit

- After each completed implementation, commit automatically when required checks pass.
  Documentation-only work is committed too.
- If required tests fail, do not commit; fix them or leave the tree uncommitted and report
  the failing output verbatim.
- A question, review, or plan with no file changes does not need a commit. Never create an
  empty commit.
- Commit once at the end of a cohesive task when the task requests one commit.

## Pre-commit checklist

1. Run git status --short. Record pre-existing work and leave it out of staging/commit.
2. Stage files by explicit path only. Never use git add ., git add -A, or git commit -a.
3. Inspect git diff --cached --stat and git diff --cached. Confirm only intended files are
   staged and there are no credentials, tokens, or debug artifacts.
4. Run npm test. When extraction code, rules, or fixtures changed, also run
   node test/eval-extract --provider rules and check that results did not regress.
5. Commit using the format below; use multiple -m flags or a message file for a body.
6. Run git log -1 --stat and git status --short. Report the short hash and header, and state
   that nothing was pushed.

Never stage .env or .oauth/ contents. Do not use --amend, rebase, reset --hard, --force,
--force-with-lease, git clean -f, commit --no-verify, commit --no-gpg-sign, or git config
changes. Do not bypass hooks. If a hook fails, fix the cause and make a new commit. Do not
add Co-authored-by or generated-by trailers unless requested. Rewrite history only if asked.

## Conventional Commits 1.0.0 format

    <type>[optional scope][!]: <description>

    [optional body]

    [optional footer(s)]

Use a lower-case allowed type, optional noun scope in parentheses, optional breaking `!`,
colon and one space, then an imperative English description with a lower-case first word,
no final period, preferably at most 72 characters. Describe the behavior change, not “update
code”. The body starts after a blank line and explains why or a tradeoff. Footers follow a
blank line and use Token: value or Token #value; use hyphens in multiword tokens. The
BREAKING CHANGE token must be uppercase. These message rules follow the
[Conventional Commits 1.0.0 specification](https://www.conventionalcommits.org/en/v1.0.0/).

### Allowed types

| Type | Use | SemVer meaning |
|---|---|---|
| feat | New user-visible behavior, endpoint, env var, card, or parsed expression | MINOR |
| fix | Bug fix to behavior, parsing, race, card, or Sheet write | PATCH |
| docs | Documentation and code comments | None |
| test | Tests, fixtures, evaluator | None |
| refactor | Behavior-preserving restructuring | None |
| perf | Performance improvement | None |
| style | Formatting only | None |
| build | package.json, scripts, Node version, dependencies | None |
| ci | CI configuration | None |
| chore | Maintenance not covered above | None |
| revert | Revert a commit, only when requested; body: This reverts commit <full-sha>. | None |

A behavior-changing rules/*.md edit is feat or fix (scope deadline, priority, or pic), not
docs or chore. SemVer labels are conventions for this repository; only feat/fix and breaking
change have the spec's usual SemVer meaning.

### Scopes

Choose an area noun from this list; add a new noun only if none fits, then reuse it:

extractor, deadline, priority, pic, prompt, seatalk, card, sheets, sheet-update, thread,
auth, routing, server, dashboard, config, eval, rules, deps.

Omit scope when the commit spans several areas or is repo-wide.

### Breaking changes in this repository

Use `!` in the header and/or a BREAKING CHANGE footer when changing:

- Google Sheet A–I column order/meaning, ID scheme, or expected header row.
- parseConfirmationButtonValue grammar in a way that invalidates cards already sent.
- An environment variable name or runtime-changing default.
- An HTTP endpoint or webhook alias meaning/removal.
- Who may confirm or update a task.

State what breaks and how to migrate. A deployment-risk note alone is not a breaking change.

### Body, footer, and splitting rules

- Types are written lower-case. Use BREAKING CHANGE uppercase in its footer.
- Keep one logical change per commit. Split unrelated features/fixes/tests/docs when possible;
  tests belonging to a feature may be included with it.
- For a revert, use type revert and include the full reverted SHA in the body. Only revert
  when the user asks.
- Do not add trailers that were not requested.

## Good and bad examples

| Good | Bad |
|---|---|
| docs: map task and OAuth flows | update code |
| fix(deadline): resolve a bare weekday after the reference date | Fix bug. |
| feat(seatalk): reply with a confirmation card in the source thread | Feat: Add stuff |
| fix(sheets): preserve the task ID when updating a row | fixed things and added tests and docs |
| test(extractor): cover holiday-aware week deadlines | feature/login: add parsing |
| refactor(thread): isolate quoted-task lookup | chore: make several unrelated changes |
| build: declare Node.js 18 as the minimum supported version | docs: Update docs. |
| feat(sheets)!: add Owner after PIC | feat(sheets): add Owner after PIC (no migration note) |
| revert: restore previous deadline precedence | revert: undo stuff |

For the breaking example, add a footer that states the new A–I layout and migration:

    BREAKING CHANGE: Sheets now use A:I; insert Owner in column D and update
    configured ranges to A:I.

For the revert example, include the full SHA in the body: This reverts commit <full-sha>.
Use revert only when the user asks.

## Quick recipe

Run these from the repository root, replacing the path list and message with the current task:

    git branch --show-current
    git status --short
    git add AGENTS.md CLAUDE.md src/AGENTS.md src/CLAUDE.md rules/AGENTS.md rules/CLAUDE.md test/AGENTS.md test/CLAUDE.md docs/INDEX.md docs/architecture.md docs/flows.md docs/extraction.md docs/integrations-and-config.md docs/testing.md docs/gotchas.md docs/git-workflow.md docs/codex-prompt-agent-docs.md
    git diff --cached --stat
    git diff --cached
    npm test
    node test/eval-extract --provider rules
    git commit -m "docs: add agent index, architecture docs and git workflow"
    git log -1 --stat
    git status --short

For non-extraction changes, run the evaluator when the task or repository instructions require
it; the docs-generation task requires it before and after regardless of changed source.
