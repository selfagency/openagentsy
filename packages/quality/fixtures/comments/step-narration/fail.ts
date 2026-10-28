export function parse(input: string): string[] {
  // Step 1: trim the input
  const trimmed = input.trim();
  // Step 2: split it on the commas
  return trimmed.split(',');
}
