# src conventions

- Keep ESM exports small and dependency direction simple; server.js orchestrates the modules.
- Preserve module boundaries: task extraction, SeaTalk messages, Sheets, thread state,
  authorization, button parsing, task acknowledgement, and Sheet-update intent each have
  separate modules.
- Keep API payload shapes and callback button values synchronized with server.js and tests.
- For extraction changes, update deterministic code, rules, EXTRACTION_PROMPT examples,
  fixtures, and tests together. Preserve explicit-revision-only merge behavior.
- Keep HTTP clients injectable: SeaTalkClient accepts fetchImpl; tests may stub global fetch
  for modules that use the built-in fetch.
- Keep all user-facing text in Vietnamese. Never add credentials or token values.
