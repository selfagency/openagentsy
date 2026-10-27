// The total of the items is what the caller asked for.
export function total(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}
