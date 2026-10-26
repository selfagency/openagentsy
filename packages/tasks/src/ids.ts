import { customAlphabet } from 'nanoid';
import BLOCKED_ID_WORDS from './blocked-id-words.json' with { type: 'json' };

/**
 * Task ids.
 *
 * An id is short, random and readable out loud, because agents say it to each
 * other and people type it into a commit message. The alphabet is the one
 * Beans uses — digits and lowercase letters, nothing that needs quoting in a
 * shell — and the length is four characters, which is short enough to type
 * and long enough not to collide in a project.
 */

/** The characters an id is made of. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** The prefix every id in this project carries. */
export const DEFAULT_PREFIX = 'oa-';

/** The number of random characters in an id. */
export const DEFAULT_LENGTH = 4;

/**
 * A new id.
 *
 * An id that contains one of the blocked words is thrown away and another is
 * drawn, so a task never gets a name a person would rather it did not have.
 * The word list lives in a data file, so it can be read, argued about and
 * extended without touching the code.
 */
export function newId(prefix: string = DEFAULT_PREFIX, length: number = DEFAULT_LENGTH): string {
  const draw = customAlphabet(ALPHABET, length);
  for (;;) {
    const id = draw();
    if (!BLOCKED_ID_WORDS.some((word: string) => id.includes(word))) return prefix + id;
  }
}
