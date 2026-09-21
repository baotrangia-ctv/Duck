function parseConfirmationButtonValue(buttonValue) {
  const value = String(buttonValue || "").trim();
  const sheetUpdateMatch = value.match(/^task:sheet-update:(confirm|updated|priority|deadline):([^:]+)(?::(.+))?$/);
  if (sheetUpdateMatch) {
    const [, action, updateId, fieldValue] = sheetUpdateMatch;
    if (action === "confirm" || action === "updated") return { kind: `sheet_update_${action}`, updateId };
    if (!fieldValue) return null;
    if (action === "priority" && !["P0", "P1", "P2"].includes(fieldValue)) return null;
    return { kind: `sheet_update_${action}`, updateId, value: fieldValue };
  }

  const clarifyMatch = value.match(/^task:clarify:([^:]+):(new|target):?([^:]*)$/);
  if (clarifyMatch) {
    const [, clarifyId, action, shortId] = clarifyMatch;
    if (action === "new") return { kind: "clarify_new", clarifyId };
    if (/^\d+$/.test(shortId)) return { kind: "clarify_target", clarifyId, shortId };
    return null;
  }

  const match = value.match(/^task:(confirm|confirmed|priority|deadline):([^:]+)(?::(.+))?$/);
  if (!match) return null;

  const [, kind, draftId, fieldValue] = match;
  if (kind === "confirm" || kind === "confirmed") return { kind, draftId };
  if (!fieldValue) return null;

  if (kind === "priority" && !["P0", "P1", "P2"].includes(fieldValue)) return null;
  return { kind, draftId, value: fieldValue };
}

export { parseConfirmationButtonValue };
