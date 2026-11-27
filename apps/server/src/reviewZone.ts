function dayKeyFormatter(timeZone: string) {
  const format = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (at: number) => {
    const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

/** First instant in a caller's local calendar day, including DST at midnight. */
export function reviewDayStart(day: string, timeZone: string): number {
  const key = dayKeyFormatter(timeZone);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  let low = midnight - 36 * 3600000, high = midnight + 36 * 3600000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (key(mid) < day) low = mid + 1; else high = mid;
  }
  if (key(low) !== day) throw new Error('该时区不存在指定日期');
  return low;
}

/** The first instant after today's local date, including DST and skipped calendar dates. */
export function reviewDayEnd(at: number, timeZone: string): number {
  const key = dayKeyFormatter(timeZone), day = key(at);
  let low = at, high = at + 48 * 3600000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (key(mid) <= day) low = mid + 1; else high = mid;
  }
  return low;
}
