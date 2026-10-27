/**
 * The words of a text.
 *
 * The comment lint compares what a comment says with what the code it
 * sits on says. Both are read as words: an identifier is split into the
 * words it is made of, and the words that say nothing on their own are
 * dropped.
 */

/**
 * The words of an identifier or of a type.
 *
 * `getUserById` is four words, and `Record<string, User>` is three, and
 * the words of a type are the words of the names inside it.
 */
export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * A word with its plural ending taken off.
 *
 * `adds` and `add` are the same word, and a comment that says "adds
 * two numbers" says no more than the signature of `add` does.
 */
export function stem(word: string): string {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The words that say nothing on their own.
 *
 * They are the words of the grammar and of the shape of a sentence, and
 * the tag names of a JSDoc block. A comment made of nothing else says
 * nothing.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'after',
  'all',
  'also',
  'an',
  'and',
  'any',
  'are',
  'arg',
  'args',
  'argument',
  'arguments',
  'as',
  'at',
  'be',
  'been',
  'before',
  'being',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'each',
  'eight',
  'else',
  'few',
  'first',
  'five',
  'for',
  'four',
  'from',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'last',
  'may',
  'me',
  'more',
  'most',
  'my',
  'next',
  'nine',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'on',
  'one',
  'only',
  'onto',
  'or',
  'other',
  'our',
  'over',
  'own',
  'param',
  'params',
  'parameter',
  'parameters',
  'second',
  'seven',
  'shall',
  'she',
  'should',
  'six',
  'so',
  'some',
  'such',
  'ten',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'third',
  'this',
  'those',
  'three',
  'to',
  'too',
  'two',
  'type',
  'types',
  'under',
  'until',
  'us',
  'value',
  'values',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'will',
  'with',
  'would',
  'you',
  'your',
]);
