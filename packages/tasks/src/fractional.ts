/**
 * Fractional order keys.
 *
 * Copyright the hmans/beans authors. Licensed under the Apache License,
 * Version 2.0. Ported from `pkg/bean/fractional.go`; see the NOTICE file.
 *
 * A key is a string of base-62 digits that sorts lexicographically. Given
 * any two keys a new one can always be found between them, so a task that
 * moves in the order only has its own key rewritten: the neighbours do not
 * move, and no other file is touched.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The highest digit, and the value the middle of the range is. */
const MAX = 61;
const MIDDLE = 31;

/**
 * A key that sorts between two keys.
 *
 * An empty first key means "before the second", an empty second key means
 * "after the first", and two empty keys give the middle of the range.
 */
export function orderBetween(a = '', b = ''): string {
  if (a === '' && b === '') return 'V';
  if (a === '') return decrementKey(b);
  if (b === '') return incrementKey(a);
  return midpoint(a, b);
}

/**
 * A key between two keys, when the first is known to sort before the second.
 */
function midpoint(a: string, b: string): string {
  const maxLength = Math.max(a.length, b.length);
  const digitsA = toIndices(padRight(a, maxLength));
  const digitsB = toIndices(padRight(b, maxLength));

  for (let i = 0; i < maxLength; i++) {
    const first = digitsA[i] ?? 0;
    const second = digitsB[i] ?? 0;
    if (first < second - 1) {
      // There is room between these two digits.
      const result = digitsA.slice(0, i);
      result.push(Math.floor((first + second) / 2));
      return fromIndices(result);
    }
    if (first === second) continue;
    // The digits are neighbours, so the key has to go deeper: take the first
    // key's prefix and hang a middle digit off it.
    const result = digitsA.slice(0, i + 1);
    const next = i + 1 < digitsA.length ? (digitsA[i + 1] ?? 0) : 0;
    result.push(Math.floor((next + 62) / 2));
    return fromIndices(result);
  }

  // The two keys are equal up to their length, so the answer is one digit
  // longer.
  const result = digitsA.slice(0);
  result.push(MIDDLE);
  return fromIndices(result);
}

/** A key that sorts after the given one. */
function incrementKey(key: string): string {
  const digits = toIndices(key);

  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = digits[i] ?? 0;
    if (digit < MAX) {
      const result = digits.slice(0, i);
      let middle = Math.floor((digit + 62) / 2);
      if (middle === digit) middle = digit + 1;
      result.push(middle);
      return fromIndices(result);
    }
  }

  // Every digit is the highest one, so the answer is one digit longer.
  const result = digits.slice(0);
  result.push(MIDDLE);
  return fromIndices(result);
}

/** A key that sorts before the given one. */
function decrementKey(key: string): string {
  const digits = toIndices(key);

  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = digits[i] ?? 0;
    if (digit > 1) {
      // Halve this digit: the middle between zero and the digit.
      const result = digits.slice(0, i);
      result.push(Math.floor(digit / 2));
      return fromIndices(result);
    }
    if (digit === 1) {
      // A zero here would shorten the key, and a shorter key does not
      // necessarily sort first. So the prefix is kept and a middle digit is
      // appended to it.
      const result = digits.slice(0, i);
      result.push(0, MIDDLE);
      return fromIndices(result);
    }
  }

  // Every digit is zero. A key of zeros sorts after its own prefix, so the
  // prefix is the answer.
  if (key.length > 1) return key.slice(0, key.length - 1);
  return '0';
}

/** A key padded with zeros to the given length. */
function padRight(key: string, length: number): string {
  let padded = key;
  while (padded.length < length) padded += DIGITS[0];
  return padded;
}

/** The digit values of a key. A character that is not a digit counts as zero. */
function toIndices(key: string): number[] {
  return [...key].map((character) => DIGITS.indexOf(character));
}

/** The key for a list of digit values. */
function fromIndices(indices: number[]): string {
  return indices
    .map((index) => Math.max(0, Math.min(index, MAX)))
    .map((index) => DIGITS[index] ?? DIGITS[0])
    .join('');
}
