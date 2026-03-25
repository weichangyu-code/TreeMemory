/**
 * Get the hour bucket key for a given timestamp.
 * Format: "2026-03-25T14" (ISO date + hour)
 */
export function getHourKey(date: Date): string {
  return date.toISOString().slice(0, 13);
}

/**
 * Get the day bucket key for a given timestamp.
 * Format: "2026-03-25"
 */
export function getDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Get the start of an hour from an hour key.
 */
export function hourKeyToStart(hourKey: string): string {
  return `${hourKey}:00:00.000Z`;
}

/**
 * Get the end of an hour from an hour key.
 */
export function hourKeyToEnd(hourKey: string): string {
  return `${hourKey}:59:59.999Z`;
}

/**
 * Get the start of a day from a day key.
 */
export function dayKeyToStart(dayKey: string): string {
  return `${dayKey}T00:00:00.000Z`;
}

/**
 * Get the end of a day from a day key.
 */
export function dayKeyToEnd(dayKey: string): string {
  return `${dayKey}T23:59:59.999Z`;
}

/**
 * Calculate the number of days between two dates.
 */
export function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return Math.abs(b - a) / (1000 * 60 * 60 * 24);
}

/**
 * Get current ISO timestamp.
 */
export function nowISO(): string {
  return new Date().toISOString();
}
