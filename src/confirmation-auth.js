function normalizeIdentity(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text || null;
}

function normalizeEmail(value) {
  const text = normalizeIdentity(value);
  return text && text.includes("@") ? text : null;
}

function getClickerIdentity(clickRecord) {
  const parsed = clickRecord?.parsed || clickRecord || {};
  const event = clickRecord?.payload?.event || {};
  return {
    email: normalizeEmail(parsed.email || clickRecord?.email || event.email),
    employeeCode: normalizeIdentity(parsed.employeeCode || clickRecord?.employeeCode || event.employee_code || event.employeeCode),
    seatalkId: normalizeIdentity(parsed.seatalkId || parsed.senderId || clickRecord?.seatalkId || event.seatalk_id || event.seatalkId),
  };
}

function isConfirmationClickAuthorized(clickRecord, conversation) {
  const clicker = getClickerIdentity(clickRecord);
  const creator = {
    email: normalizeEmail(conversation?.creatorEmail),
    employeeCode: normalizeIdentity(conversation?.creatorEmployeeCode),
    seatalkId: normalizeIdentity(conversation?.creatorSeatalkId),
  };

  for (const field of ["email", "employeeCode", "seatalkId"]) {
    if (!clicker[field]) continue;
    if (creator[field]) return clicker[field] === creator[field];
  }

  // SeaTalk can omit clicker identity fields. Preserve the existing fail-open behavior.
  return true;
}

function isClarificationClickAuthorized(clickRecord, clarification) {
  const clicker = getClickerIdentity(clickRecord);
  const sender = {
    email: normalizeEmail(clarification?.senderEmail),
    employeeCode: normalizeIdentity(clarification?.senderEmployeeCode),
    seatalkId: normalizeIdentity(clarification?.senderSeatalkId),
  };
  const expectedFields = ["email", "employeeCode", "seatalkId"].filter((field) => sender[field]);
  if (!expectedFields.length) return false;

  return expectedFields.some((field) => clicker[field] && clicker[field] === sender[field]);
}

function matchesExpectedIdentity(clickRecord, expected, { failOpen = false } = {}) {
  const actor = getClickerIdentity(clickRecord);
  const fields = ["email", "employeeCode", "seatalkId"]
    .filter((field) => expected?.[field])
    .map((field) => [field, normalizeIdentity(expected[field])]);
  if (!fields.length) return false;
  const actorHasIdentity = fields.some(([field]) => actor[field]);
  if (!actorHasIdentity) return failOpen;
  return fields.some(([field, value]) => actor[field] && actor[field] === value);
}

function isTaskMessageUpdateAuthorized(messageRecord, task) {
  if (task?.written) {
    return matchesExpectedIdentity(messageRecord, { email: task?.fields?.pic });
  }
  return matchesExpectedIdentity(messageRecord, {
    email: task?.creatorEmail,
    employeeCode: task?.creatorEmployeeCode,
    seatalkId: task?.creatorSeatalkId,
  });
}

function isSheetUpdateClickAuthorized(clickRecord, pending) {
  const expectedEmail = normalizeEmail(pending?.picEmail);
  const clicker = getClickerIdentity(clickRecord);
  return Boolean(expectedEmail && clicker.email && clicker.email === expectedEmail);
}

export {
  isConfirmationClickAuthorized,
  isClarificationClickAuthorized,
  isTaskMessageUpdateAuthorized,
  isSheetUpdateClickAuthorized,
};
