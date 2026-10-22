# Task Priority Policy

Priority is evaluated based on the task's deadline and the content available at the time of evaluation. No follow-up question or user response is required — priority must be determined solely from the information already provided.

## Priority levels

- **P0 — Urgent:** The deadline is today or tomorrow (within 1 calendar day), or the task is overdue.
- **P1 — Important:** The deadline is 2–3 calendar days away.
- **P2 — Normal:** The deadline is more than 3 calendar days away.

## Khi deadline chưa được cung cấp

- Nếu message có nhãn Priority rõ ràng (`P0`, `P1`, `P2`), giữ nhãn đó.
- Có thể nhận diện ngôn ngữ ưu tiên rõ ràng: "khẩn cấp", "rất gấp", "làm gấp", "urgent", "ASAP" → P0; "quan trọng", "ưu tiên", "important" → P1; "bình thường", "không gấp", "normal" → P2.
- Khi đã có Priority nhưng chưa có deadline, suy ra deadline như sau:
  - P0 → hôm nay.
  - P1 → sau 3 ngày lịch.
  - P2 → sau 7 ngày lịch.

## Default priority

- If the task has no deadline and no usable Priority signal, the priority defaults to P2 — Normal and the deadline defaults to 7 calendar days after the reference date.
- Do not infer priority from sender or topic. Only an explicit Priority label, clear urgency wording listed above, or a valid deadline may change the default.

## Priority precedence and deadline escalation

Apply these sources in order:

1. An explicit user label (`P0`, `P1`, or `P2`) wins, including when the
   deadline is today or overdue. For example, `priority P2` plus a deadline
   today remains P2.
2. A clear urgency word wins when there is no explicit label: urgent wording
   maps to P0, important wording to P1, and "không gấp" / normal wording to P2.
3. If the user gave no priority signal, derive priority from the resolved
   deadline: today, tomorrow, or overdue → P0; 2–3 days away → P1; more than
   3 days away → P2.
4. If neither a priority signal nor a deadline exists, use P2 and the default
   deadline 7 calendar days after the reference date.

Deadline-date escalation applies only when priority is deadline-derived. A
deadline today or in the past is P0 until resolved or cancelled. A user label
or urgency word takes precedence over this date-based result.

Only evaluate priority. Do not schedule reminders, ask follow-up questions, escalate through external tools, or call any tool.
