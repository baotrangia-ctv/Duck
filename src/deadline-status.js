function computeDeadlineStatus(deadline, now = new Date()) {
  const unknown = "Chưa xác định Deadline";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(now));
    const part = (type) => Number(parts.find((item) => item.type === type).value);
    const today = Date.UTC(part("year"), part("month") - 1, part("day"));
    const value = String(deadline ?? "").trim();
    let year, month, day;
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const local = value.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
    if (iso) [, year, month, day] = iso.map(Number);
    else if (local) {
      day = Number(local[1]);
      month = Number(local[2]);
      year = local[3] ? Number(local[3]) : part("year");
    } else return unknown;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return unknown;
    const days = Math.round((date.getTime() - today) / 86_400_000);
    if (days > 0) return `Còn ${days} ngày đến Deadline`;
    if (days < 0) return `Quá ${-days} ngày so với Deadline`;
    return "Đã đến Deadline";
  } catch {
    return unknown;
  }
}

export { computeDeadlineStatus };
