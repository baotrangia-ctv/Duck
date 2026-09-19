# PIC Extraction Policy

- PIC is the person responsible for the task, not automatically the sender.
- Use event.message.text.mentioned_list to match mentions by username, email, employee_code, location, and length.
- Ignore the bot mention used only to route the message.
- For phrases such as "giao cho @A", "log task cho @A", "ghi task cho @A", or "tạo task cho @A", select the mentioned person after the assignment phrase.
- If exactly one non-routing person is mentioned, select that person as PIC even when the message uses a different assignment verb.
- If the message does not name another assignee, or uses first-person wording such as "tôi", "mình", "em", "tớ", "me", or "myself", assign the task to the sender.
- Read the sender email from the first available payload field among event.email, event.message.sender.email, event.sender.email, event.user.email, event.from.email, event.employee_email, and event.sender_email.
- PIC must be an email address. If the selected person has no email in the payload, return null; never invent or infer an email.
