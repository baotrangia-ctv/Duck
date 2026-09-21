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

export { isConfirmationClickAuthorized };
