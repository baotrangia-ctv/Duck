# rules conventions

- PIC_POLICY.md, DEADLINE_POLICY.md, and TASK_PRIORITY_POLICY.md are read at import by
  src/task-extractor.js and embedded into EXTRACTION_PROMPT.
- Keep policy wording consistent with deterministic parsing, prompt few-shot examples,
  test/fixtures/extraction-cases.json, and tests.
- Preserve Vietnamese user phrases and date/priority examples. Deadlines use the
  Asia/Ho_Chi_Minh reference date and output DD/MM/YYYY.
- Rules affect the LLM prompt; do not assume a markdown edit alone changes rules-provider
  parsing. Update code and tests for rules-only behavior.
- Restart a running server after edits. Do not put secrets or real user data in rules.
