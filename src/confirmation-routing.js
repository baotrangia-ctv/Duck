function parseConfirmationButtonValue(buttonValue) {
  const value = String(buttonValue || "").trim();
  const match = value.match(/^task:(confirm|confirmed|priority|deadline):([^:]+)(?::(.+))?$/);
  if (!match) return null;

  const [, kind, draftId, fieldValue] = match;
  if (kind === "confirm" || kind === "confirmed") return { kind, draftId };
  if (!fieldValue) return null;

  if (kind === "priority" && !["P0", "P1", "P2"].includes(fieldValue)) return null;
  return { kind, draftId, value: fieldValue };
}

export { parseConfirmationButtonValue };
