---
name: deploy-duck
description: Prepare, deploy, and diagnose this SeaTalk inbox on Garena Demo System using ZIP upload, including its OAuth, allowlist, Sheets, and SeaTalk runtime configuration.
---

# Deploy Duck through Demo System

Use this for an explicitly requested deployment of this repository, or diagnosis of its deployed integrations. Read the root `AGENTS.md` and `docs/git-workflow.md` first. A request to write or maintain this skill does not authorize a live deployment.

## Target and source

- Existing project: **[Craftland] Duck**, ID `cmvkpqg7f01efq1lwuhx8kdsx`.
- Project UI: `https://demo.ved.com.vn/projects/cmvkpqg7f01efq1lwuhx8kdsx`.
- Public origin: `https://craftland-duck.demo.ved.com.vn`.
- Work on `master`; preserve unrelated changes. Package the intended committed revision. Do not create a project, branch, push, or PR as a deployment workaround.
- Discover `demo_system_*` tools in MCP Garena. The tool set may lack project search and general environment-variable management. Use the known project ID; ask for a different ID if the user selects another target.

## Prepare the complete runtime configuration

Use [the environment inventory](../../../docs/integrations-and-config.md) to distinguish required values, optional providers, and retired keys. Honor existing user authorization for configuration reads and transfer; never print values, dump `.env`, commit credentials, or copy all of `.auth/`.

Inspect the current deployment and, when signed in, `/api/health` before choosing an extractor. Preserve the production provider unless the user requests a change. Local `auto` may select a configured Chatflow/Compass service, whereas a prior deployment may deliberately use `rules`. Do not enable writes just to make a preflight pass.

Run the offline packager from the repository root:

```powershell
./.agents/skills/deploy-duck/scripts/build-demo-zip.ps1 -Extractor rules
```

Choose `rules`, `chatflow`, `compass`, or `auto` deliberately. The script uses process environment values before `.env`, includes only supported runtime keys, and reports names/flags rather than values. It archives committed `package.json`, `server.js`, `src/`, `rules/`, and `public/`; remaps the selected allowlist/key to portable `.auth/` paths; and overrides deployment `HOST`, `PORT`, and callback URI. It does not modify local configuration or upload anything. Its ZIP contains credentials: keep it outside the repo and remove that exact file after upload/failure.

Before deployment, resolve missing inputs as one configuration checklist instead of deploying one credential at a time:

| Capability | Required configuration / check |
|---|---|
| Public webhook | Signing secret from the intended SeaTalk app; public callback `/callback`; signature validation stays enabled |
| Dashboard login | Web OAuth client ID/secret, HTTPS `/auth/google/callback` registered in Google, valid nonempty owner/viewer allowlist |
| Sheets | Spreadsheet ID, correct tab/range A–I, usable service-account key, Sheet shared appropriately; OAuth login does not grant Sheets access |
| SeaTalk outbound | Matching App ID + App Secret, or an intentional pre-issued access token; a signing secret cannot send cards |
| Reminders | **Get Employee Code with Email** permission; **Send Message to Bot User** permission and suitable Service Scope for PICs |
| Extraction | Explicit provider and that provider's configured credentials; `rules` needs no LLM credentials |
| Session continuity | Preserve the production session secret when available. If neither explicit secret nor persisted local session-secret file is supplied, report that users must sign in again after replacement |

Read-only preflight, when authorized: obtain a SeaTalk app token, read Sheets metadata/tab, and resolve an intended PIC email. Do not test by writing rows or replaying a reminder that sends DMs without explicit authorization. Use existing service-account credentials when possible; do not create or rotate keys to bypass a missing local file. Creating keys, broadening app permissions, or sharing a Sheet requires the applicable approval at the actual action.

## Upload and deploy

1. Run `npm test`; run the rules evaluator when extraction-adjacent code changed. Commit completed implementation changes per repo policy. Configuration-only packaging needs no empty commit.
2. Build one complete ZIP. Inspect entry names, not credential contents. Never package `.oauth/`, node_modules, git history, unrelated keys, or the untracked reminder plan.
3. Hosted MCP `demo_system_upload_zip` requires **zipBase64**; `localPath` is for local/stdio transport. Encode and pass Base64 inside the tool orchestration without emitting it to chat or logs. Check tool `isError`/structured errors before continuing. Record uploaded source revision.
4. Run `demo_system_run_deployment_check`, then `demo_system_deploy`. The static detector may warn about localhost references or fail to infer the port; verify code listens on `0.0.0.0` and that the ZIP sets the platform port (3000 by default). Do not dismiss real validation errors.
5. Wait for a terminal status with bounded checks; inspect sanitized logs on failure rather than repeatedly deploying unchanged inputs. A failed replacement can leave no running container: report that state promptly. Do not stop a healthy deployment just to inspect it.
6. Confirm `RUNNING`, `/healthz` HTTP 200, and actual OAuth destination/callback. With a normal authorized login, check `/api/health` and `/api/google/status` or the dashboard: `seatalkConfigured`, `googleSheetsConfigured`, `googleSheetsAuthorized`, and Sheet access must be true for the enabled features. Do not mint a dashboard session or weaken authentication for verification.
7. Report URL, revision/deployment status, validated capabilities, and remaining checks. `RUNNING` alone is not proof of a working bot. Remove the temporary credential-bearing ZIP; never expose the ZIP for download as a public artifact.

## Diagnose by layer

| Symptom | Evidence and next action |
|---|---|
| Redirect to localhost | Public callback missing/stale; use the HTTPS deployment callback. Public-to-loopback configurations return `/login?error=config` |
| Google login config error | Missing OAuth client fields; do not confuse this with Sheets service-account credentials |
| Sheets not ready | Check configuration/key first, then token and metadata access. Share/Editor issues differ from a missing key |
| SeaTalk not configured | Outbound App ID/Secret or token missing; receiving webhooks can still work |
| HTTP 200, code 103, app permission denied | SeaTalk API failure, not transport success. Identify the failing endpoint, verify app identity and its exact API permission |
| PIC lookup returns no code | Official response uses `employees`, per-entry `code` and `employee_status`; prefer a unique in-position identity, avoid terminated/ambiguous identities. Endpoint: [official API](https://open.seatalk.io/docs/get-employee-code-with-email) |
| Lookup works but DM fails | Check **Send Message to Bot User**, PIC's Service Scope and bot access; lookup permission is listed No Limit and does not itself allow messaging |
| Missing group message | Check `SeaTalk webhook:` logs: no receipt vs `signature_missing`/`signature_mismatch` vs accepted. Compare Event Callback delivery history/subscriptions and exact URL. Keep signature verification on |
| Server accepts but page is empty | Check session/login and SSE; reload and compare the HTTP snapshot before changing parsing. In-memory inbox/thread state resets on redeploy |

Do not broaden Service Scope to the whole company, change signing secrets, disable auth, or replay notifications as a generic repair.
