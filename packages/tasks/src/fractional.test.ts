import { describe, expect, it } from 'vitest';
import { orderBetween } from './fractional.js';

/**
 * The fractional order keys, as the Beans test file states them.
 *
 * These cases are the ones from hmans/beans, `pkg/bean/fractional_test.go`,
 * translated: a key that sorts between two keys, a key that sorts after
 * the last one, a key that sorts before the first one, and the long runs
 * of insertions that a real board makes.
 */
describe('orderBetween', () => {
  it('gives the middle of the range when there is nothing on either side', () => {
    expect(orderBetween('', '')).toBe('V');
  });

  it('gives a key that sorts before the second one', () => {
    const result = orderBetween('', 'V');
    expect(result).not.toBe('');
    expect(result < 'V').toBe(true);
  });

  it('gives a key that sorts after the first one', () => {
    expect(orderBetween('V', '') > 'V').toBe(true);
  });

  const between: [string, string][] = [
    ['A', 'Z'],
    ['V', 'X'],
    ['a', 'z'],
    ['0', 'z'],
    ['Va', 'Vz'],
    ['V', 'W'],
  ];

  it.each(between)('gives a key between %s and %s', (a, b) => {
    const result = orderBetween(a, b);
    expect(result > a).toBe(true);
    expect(result < b).toBe(true);
  });

  it('goes deeper when the two digits are neighbours', () => {
    const result = orderBetween('A', 'B');
    expect(result > 'A').toBe(true);
    expect(result < 'B').toBe(true);
  });

  it('keeps the order through fifty insertions at the end', () => {
    const keys = ['V'];
    for (let index = 0; index < 50; index++) {
      const next = orderBetween(keys[keys.length - 1] ?? 'V', '');
      expect(next > (keys[keys.length - 1] ?? 'V')).toBe(true);
      keys.push(next);
    }
    for (let index = 1; index < keys.length; index++) {
      expect((keys[index] ?? '') > (keys[index - 1] ?? '')).toBe(true);
    }
  });

  it('keeps the order through fifty insertions at the start', () => {
    const keys = ['V'];
    for (let index = 0; index < 50; index++) {
      const next = orderBetween('', keys[0] ?? 'V');
      expect(next < (keys[0] ?? 'V')).toBe(true);
      keys.unshift(next);
    }
    for (let index = 1; index < keys.length; index++) {
      expect((keys[index] ?? '') > (keys[index - 1] ?? '')).toBe(true);
    }
  });

  it('keeps the order through a hundred insertions between two keys', () => {
    let a = 'A';
    let b = 'z';
    for (let index = 0; index < 100; index++) {
      const middle = orderBetween(a, b);
      expect(middle > a).toBe(true);
      expect(middle < b).toBe(true);
      if (index % 2 === 0) b = middle;
      else a = middle;
    }
  });
});
