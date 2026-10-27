export function parse(input: string): string[] {
  // The caller passes a comma separated list, so the split is on the comma.
  return input.trim().split(',');
}
