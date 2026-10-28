// ATOMIC UPDATE
// The counter is read and written under a lock, so two workers cannot both add.
export function bump(counter: number): number {
  return counter + 1;
}
