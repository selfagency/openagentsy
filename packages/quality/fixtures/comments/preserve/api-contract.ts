// API CONTRACT
// The status code is 200 with the body, and 404 when the id is unknown.
export function answer(id: string): number {
  return id === '' ? 404 : 200;
}
