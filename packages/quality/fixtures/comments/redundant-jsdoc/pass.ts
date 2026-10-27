/**
 * Adds two numbers, and throws when either one is not finite.
 */
export function add(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new RangeError('the numbers must be finite');
  }
  return a + b;
}
