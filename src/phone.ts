/**
 * Normalise a Bangladeshi mobile number to the 11-digit `01XXXXXXXXX` form
 * Steadfast expects. Accepts `+8801…`, `8801…`, `01…`, with spaces, dashes or
 * dots. Returns `null` for anything that isn't a BD mobile number.
 */
export function normalizeBdPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  const local = digits.startsWith('880') ? `0${digits.slice(3)}` : digits;
  return /^01[3-9]\d{8}$/.test(local) ? local : null;
}
