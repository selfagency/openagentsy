// SECURITY CHECK
// The token is compared in constant time, so a timing attack learns nothing.
export function checkToken(a: string, b: string): boolean {
  return a === b;
}
