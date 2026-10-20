import type { QuietHours } from '../config/schema';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Returns the weekday (0 = Sunday) and minutes past midnight of `date` in `timeZone`. */
export function localTime(date: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return { weekday: WEEKDAYS[get('weekday')] ?? 0, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when reviewer messages must not be sent at `date`. */
export function isQuietTime(date: Date, quiet: QuietHours, timeZone: string): boolean {
  if (!quiet.enabled) {
    return false;
  }
  const { weekday, minutes } = localTime(date, timeZone);
  if (quiet.quietDays.includes(weekday)) {
    return true;
  }
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) {
    return false;
  }
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Returns `date` if sending is allowed, otherwise the first minute of the next
 * allowed window. Steps through wall-clock minutes so DST changes are handled.
 */
export function nextAllowedTime(date: Date, quiet: QuietHours, timeZone: string): Date {
  if (!isQuietTime(date, quiet, timeZone)) {
    return date;
  }
  // Align to the next whole minute, then step hour-by-hour and refine minute-by-minute.
  let t = new Date(Math.ceil(date.getTime() / 60_000) * 60_000);
  const limit = date.getTime() + 8 * 24 * 60 * 60_000;
  while (t.getTime() < limit && isQuietTime(new Date(t.getTime() + 60 * 60_000), quiet, timeZone)) {
    t = new Date(t.getTime() + 60 * 60_000);
  }
  while (t.getTime() < limit && isQuietTime(t, quiet, timeZone)) {
    t = new Date(t.getTime() + 60_000);
  }
  return t;
}
