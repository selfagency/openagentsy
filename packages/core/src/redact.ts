/**
 * Secret redaction.
 *
 * Everything that is stored goes through this first: a board record, a
 * harvested memory candidate, a task body. An agent pastes a key into a
 * message, and the message is written to disk a moment later. The redaction
 * removes the key and says what was removed without keeping any of it: a
 * match becomes «redacted:<name>», and the name is the pattern that matched.
 */

/**
 * The patterns, in the order they are matched.
 *
 * The order decides two things: the order the matches are reported in, and
 * which pattern owns a piece of text that two patterns both match. The list
 * is fixed by the plan (§8.4).
 */
const PATTERNS: [name: string, re: RegExp][] = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g],
  [
    'private-key',
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  ],
  [
    'generic-assign',
    /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?([A-Za-z0-9/+_=-]{16,})/gi,
  ],
];

/**
 * The pattern whose matches are only secrets when the value looks random.
 *
 * A name and a value are not a secret on their own: `password = ******` and
 * `token: undefined` are both assignments. The value has to look like
 * something a machine generated, and that is what the entropy guard checks.
 */
const ENTROPY_GUARDED = 'generic-assign';

/**
 * Shannon entropy, in bits per character, above which a value is a secret.
 *
 * Four bits per character carries sixteen distinct characters evenly, so a
 * sixteen-character value can never pass this line: the shortest value that
 * can is seventeen characters, and a real one is twenty or more.
 */
const MIN_ENTROPY = 4;

/** A secret, and the text it was found in. */
type Candidate = {
  name: string;
  match: string;
  start: number;
  end: number;
  order: number;
};

/**
 * The Shannon entropy of a string, in bits per character.
 */
function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / text.length;
    entropy -= share * Math.log2(share);
  }
  return entropy;
}

/**
 * Whether a captured assignment value is a secret.
 */
function isSecretValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return shannonEntropy(value) > MIN_ENTROPY;
}

/**
 * Every secret in the text, in pattern order.
 *
 * The patterns are matched one after the other over the original text, and a
 * match that overlaps a match already accepted is dropped: the earlier
 * pattern owns that text. The one exception is a match on the exact span of
 * an accepted match. The openai pattern matches an anthropic key too, because
 * an anthropic key is an openai-shaped token, and the two patterns match
 * exactly the same text. The later pattern is the narrower one there, so it
 * names the secret, and the openai name is left for a plain `sk-` key.
 */
function collect(s: string): Candidate[] {
  const accepted: Candidate[] = [];
  PATTERNS.forEach(([name, re], order) => {
    for (const found of s.matchAll(re)) {
      const text = found[0];
      if (text === undefined) continue;
      if (name === ENTROPY_GUARDED && !isSecretValue(found[1])) continue;
      const start = found.index;
      const end = start + text.length;
      const twin = accepted.find((candidate) => candidate.start === start && candidate.end === end);
      if (twin !== undefined) {
        twin.name = name;
        twin.match = text;
        twin.order = order;
        continue;
      }
      if (accepted.some((candidate) => candidate.start < end && start < candidate.end)) continue;
      accepted.push({ name, match: text, start, end, order });
    }
  });
  return accepted;
}

/**
 * The secrets in the text, in the order the patterns are matched.
 */
export function findSecrets(s: string): { name: string; match: string }[] {
  return collect(s)
    .sort((a, b) => a.order - b.order || a.start - b.start)
    .map((candidate) => ({ name: candidate.name, match: candidate.match }));
}

/**
 * The text with every secret replaced, and the number of replacements.
 *
 * The replacements are made on the original text, at the offsets the matches
 * were found at, so a label a replacement introduced is never matched again.
 */
export function redact(s: string): { text: string; count: number } {
  const candidates = collect(s).sort((a, b) => a.start - b.start);
  if (candidates.length === 0) return { text: s, count: 0 };
  let text = '';
  let cursor = 0;
  for (const candidate of candidates) {
    text += s.slice(cursor, candidate.start);
    text += `«redacted:${candidate.name}»`;
    cursor = candidate.end;
  }
  text += s.slice(cursor);
  return { text, count: candidates.length };
}
