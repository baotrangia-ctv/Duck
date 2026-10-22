# Task extraction

## Provider selection

createTaskExtractor accepts auto, chatflow, compass, or rules:

| Setting | Selection |
|---|---|
| rules | Always use deterministic local extraction |
| chatflow | Use Chatflow only when both URL and token exist; otherwise rules |
| compass | Use Compass only when base URL and API key exist; otherwise rules |
| auto | Prefer configured Chatflow, then configured Compass, then rules |

providerName() determines both the active provider and configured. configured is true exactly
when providerName() is not rules; it does not mean Google Sheets or SeaTalk is configured.
Chatflow calls the configured URL with a Bearer token and parses JSON/SSE text. Compass uses
the chat-completions endpoint and its configured model.

## Extraction pipeline

1. At module import, task-extractor.js reads PIC_POLICY.md, DEADLINE_POLICY.md, and
   TASK_PRIORITY_POLICY.md once, then interpolates them into EXTRACTION_PROMPT. Restart the
   process after editing a rule.
2. extract computes labeled-field fallback, payload hints, a code-parsed deadline expression,
   mention metadata, inferred priority, and the active provider.
3. The rules provider merges payload hints ahead of labeled fallback/message text, then calls
   mergeRevisionFields and finalizeFields; cleanTaskContent removes routing, mentions, and
   the matched date text.
4. Chatflow/Compass returns JSON-like content. parseTaskFields normalizes it, including
   deadline_expression. mergeFields prefers its first argument's nonempty values. Payload
   hints take precedence over model fields, which take precedence over fallback fields.
5. Reasonable model task text (3–500 characters) is preferred for task content. Code-derived
   priority replaces the model's priority. Code-parsed deadlines from the message take
   precedence over model dates; model deadline is a fallback when code cannot resolve one.
6. mergeRevisionFields compares explicit revision signals and preserves every previous field
   without a matching signal. finalizeFields supplies a deadline, derives priority if needed,
   and defaults status to TODO. cleanTaskContent returns a cleaned, capitalized task
   string or null.

## Field precedence and defaults

| Field | Actual code precedence |
|---|---|
| PIC | Payload mention/sender hints → model PIC → labeled fallback. Policy says never infer an email; parser validates email syntax, and an unresolved non-routing mention may leave PIC null. |
| Deadline | Code-resolved message expression/payload hint → code-resolved labeled fallback → model deadline_expression/deadline → priority-derived date → P2's seven-day default. |
| Priority | Labeled fallback (for example a Priority: P1 field) → inferPriorityFromText → resolved deadline (today/tomorrow/overdue=P0, 2–3 days=P1, later=P2) → P2. Model priority is overwritten by code. |
| Task | Reasonable model task content → payload/fallback task text; cleanTaskContent strips mentions, date, routing/polite filler, and priority labels. |
| Status | Parsed/fallback status if valid → TODO. Accepted values are TODO, IN PROGRESS, DONE, NOT DO. |
| Revision | Existing field is retained unless the new message has an explicit signal for that field. |

The priority rule document says an explicit P0/P1/P2 label wins over urgency wording. The
current deterministic inference scans P2 wording first, then P0 wording, then P1 wording;
when a message contains a non-field label and a conflicting urgency word, this can disagree
with the policy. See [gotchas](gotchas.md) and add a conflict fixture before changing it.

## Dates and holidays

- Runtime reference date uses Asia/Ho_Chi_Minh. The evaluator pins 2026-10-22 unless overridden.
- Output is DD/MM/YYYY. Date-only times are discarded after selecting their calendar date.
- Explicit full dates are validated. A date without a year resolves to the nearest future
  occurrence. A bare day-of-month and an unqualified weekday also resolve strictly after the
  reference date; explicit relative words such as hôm qua keep their past date.
- Week-based deadlines use Monday–Sunday. “Tuần sau” picks the last working day in that week;
  weekends and dates parsed from HOLIDAY_DATES are excluded. “Cuối tuần” means Sunday.
- HOLIDAY_DATES accepts comma-, semicolon-, or whitespace-separated DD/MM/YYYY or YYYY-MM-DD.
  Holidays affect last-working-day-of-week selection.
- With no deadline or priority, the code defaults to P2 and seven calendar days after reference
  date. When only a priority exists, P0 maps to today, P1 to +3 calendar days, and P2 to +7.

## Keep policy, code, prompt, and tests aligned

For behavior changes, update all relevant layers together:

1. rules/*.md for the human-readable policy that is injected into the LLM prompt.
2. src/task-extractor.js for deterministic parsing, precedence, and EXTRACTION_PROMPT few-shots.
3. test/fixtures/extraction-cases.json and focused node:test cases.
4. Re-run the rules evaluation and inspect field-level mismatches.

Rule markdown is prompt input; it does not by itself alter deterministic rules-provider parsing.
Tests also assert prompt text and few-shot examples.

## Evaluate extraction

    node test/eval-extract --provider rules
    node test/eval-extract --provider rules --reference-date 2026-10-22
    node test/eval-extract --provider rules --details

The evaluator reports exact-match accuracy for deadline, priority, and task. --details prints
only mismatched cases and fields. Add a fixture object with message, deadline, priority, and
task expectations. Keep the evaluator reference date in mind when using relative expressions.
Provider values other than rules may call configured external LLM services.
