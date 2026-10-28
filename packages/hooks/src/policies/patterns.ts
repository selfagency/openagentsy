/**
 * The patterns the output policies share.
 *
 * The detectors of §8.6 and the policies of §21.1 look at the same prose,
 * so the way a pattern is applied to a text is written once: a pattern is
 * tried against the text, the matches are collected, and a match that is
 * already there is not collected twice.
 */

/**
 * The text a set of patterns matched.
 *
 * Every pattern is tried against the whole text, and the matches are
 * returned in the order the patterns are written, so a text that trips two
 * of them says which two.
 */
export function matches(patterns: readonly RegExp[], text: string): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (value === undefined || value.length === 0) continue;
      if (found.includes(value)) continue;
      found.push(value);
    }
  }
  return found;
}
