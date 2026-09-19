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

## Deadline-date escalation

On the deadline date:

- P1 tasks are escalated to P0.
- P2 tasks are escalated to P0.
- P0 tasks remain P0.

Overdue tasks are treated as P0 until resolved or cancelled.

Only evaluate priority. Do not schedule reminders, ask follow-up questions, escalate through external tools, or call any tool.
