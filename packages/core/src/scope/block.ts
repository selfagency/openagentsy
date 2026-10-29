/**
 * The scope block: the shape a role's scope takes in a roles file.
 *
 * A role's permissions say what the role may *call*. The scope block says
 * what the role is *for*, and what it refuses to do. A block is five fields:
 *
 *   scope:
 *     purpose: "one sentence"
 *     in_scope: ["...", "..."]
 *     out_of_scope: ["...", "..."]
 *     refusal_pattern: "I'm the Role; my job is to coordinate. [request] is out of my scope. [redirect]."
 *     redirect: "Ask a person, or use /oa scope to see what each role does."
 *
 * The block lives in code-readable data because it has to be matched
 * against a request at runtime. `roles.yaml` is a person's file, so the
 * declarations of the first-party roles ship in `scope-declarations.yaml`,
 * and a person pastes the block into the roles file when they want it there.
 */

/**
 * A scope block.
 *
 * The two lists hold statements, and the statements are what the check
 * matches a request against: a request is out of scope when it carries the
 * words of one of them.
 */
export type ScopeBlock = {
  /** What the role is for, in one sentence. */
  purpose: string;
  /** What the role does. */
  in_scope: string[];
  /** What the role refuses to do. */
  out_of_scope: string[];
  /** The sentence the refusal is built from. */
  refusal_pattern: string;
  /** Where the refused work goes. */
  redirect: string;
};

/** A block that does not hold what a block has to hold. */
export class ScopeBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeBlockError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The words of a statement that carry the meaning.
 *
 * A short word and a word that only holds the sentence together are left
 * out: the check matches on the words that name the thing, so that "write
 * the code" matches the entry "write code" and "encode the payload" does
 * not match it.
 */
const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'and',
  'any',
  'are',
  'because',
  'been',
  'before',
  'being',
  'between',
  'both',
  'but',
  'can',
  'could',
  'did',
  'does',
  'doing',
  'done',
  'each',
  'every',
  'from',
  'had',
  'has',
  'have',
  'her',
  'here',
  'his',
  'how',
  'into',
  'its',
  'just',
  'like',
  'made',
  'many',
  'may',
  'might',
  'more',
  'most',
  'much',
  'must',
  'not',
  'off',
  'once',
  'only',
  'onto',
  'our',
  'out',
  'over',
  'own',
  'per',
  'same',
  'shall',
  'she',
  'should',
  'since',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'until',
  'upon',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'within',
  'without',
  'would',
  'you',
  'your',
]);

/** The words of a text, in lower case and without punctuation. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word !== '');
}

/** The words of a text that carry the meaning. */
function meaningful(text: string): string[] {
  return words(text).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/**
 * Whether a request carries an entry.
 *
 * The match is on words, and it needs every word of the entry: a request
 * that carries some of them is a request about something else. The words
 * are whole words, so "code" does not match "encode".
 *
 * An entry with no word worth matching states a duty rather than a request
 * to refuse, and it never matches.
 */
export function scopeBlockMatches(request: string, entry: string): boolean {
  const needed = meaningful(entry);
  if (needed.length === 0) return false;
  const carried = new Set(words(request));
  return needed.every((word) => carried.has(word));
}

/**
 * The refusal, as it is put to the requester.
 *
 * The pattern carries the request and the redirect, and both are filled in,
 * so a refusal always names the work that was asked for and the way to
 * carry it on.
 */
export function renderScopeRefusal(block: ScopeBlock, request: string): string {
  // The redirect ends in a full stop and the pattern ends in one too, so the
  // redirect's own stop is dropped and the sentence keeps a single stop.
  const redirect = block.redirect.replace(/\.\s*$/, '');
  return block.refusal_pattern
    .replace('[request]', () => request.trim())
    .replace('[redirect]', () => redirect)
    .replace('[purpose]', () => block.purpose);
}

/**
 * Whether a request is out of scope, and the refusal when it is.
 *
 * The decision is code, not a judgement: the request is matched against the
 * out-of-scope list, and the answer is the same for the same request every
 * time. A request that matches nothing is not refused: the block says what
 * the role refuses, and a request it does not name is one the role has not
 * refused.
 */
export function refuseIfOutOfScope(request: string, block: ScopeBlock): string | undefined {
  const refused = block.out_of_scope.some((entry) => scopeBlockMatches(request, entry));
  if (!refused) return undefined;
  return renderScopeRefusal(block, request);
}

/**
 * What is wrong with a block, if anything.
 *
 * The validator returns the problems rather than throwing, so a caller can
 * report all of them at once.
 */
export function validateScopeBlock(block: ScopeBlock): string[] {
  const problems: string[] = [];
  if (block.purpose.trim() === '') problems.push('purpose: expected a non-empty string');
  problems.push(...listProblems('in_scope', block.in_scope));
  problems.push(...listProblems('out_of_scope', block.out_of_scope));
  if (block.refusal_pattern.trim() === '') {
    problems.push('refusal_pattern: expected a non-empty string');
  }
  if (block.redirect.trim() === '') problems.push('redirect: expected a non-empty string');
  return problems;
}

/** The problems of one list of a block. */
function listProblems(where: string, entries: string[]): string[] {
  if (entries.length === 0) return [`${where}: expected at least one entry`];
  const problems: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      problems.push(`${where}[${index}]: expected a non-empty string`);
    }
  }
  return problems;
}

/**
 * Read a block out of what a file holds.
 *
 * The parser refuses a block that does not hold the five fields, and it
 * names the field that is wrong: a roles file with a broken block fails
 * where the block is, and not later at the first request.
 */
export function parseScopeBlock(value: unknown, where: string): ScopeBlock {
  if (!isRecord(value)) {
    throw new ScopeBlockError(`${where}: expected a mapping`);
  }

  const purpose = asText(value.purpose, `${where}.purpose`);
  const inScope = asList(value.in_scope, `${where}.in_scope`);
  const outOfScope = asList(value.out_of_scope, `${where}.out_of_scope`);
  const refusalPattern = asText(value.refusal_pattern, `${where}.refusal_pattern`);
  const redirect = asText(value.redirect, `${where}.redirect`);

  return {
    purpose,
    in_scope: inScope,
    out_of_scope: outOfScope,
    refusal_pattern: refusalPattern,
    redirect,
  };
}

/** A non-empty string, or the reason there is none. */
function asText(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScopeBlockError(`${where}: expected a non-empty string`);
  }
  return value;
}

/** A list of non-empty strings, or the reason there is none. */
function asList(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new ScopeBlockError(`${where}: expected a list of strings`);
  }
  if (value.length === 0) {
    throw new ScopeBlockError(`${where}: expected at least one entry`);
  }
  return value.map((entry, index) => asText(entry, `${where}[${index}]`));
}
