import { describe, expect, it } from 'vitest';
import { contrastRatio, hueOf, parseColour, relativeLuminance } from './colour.js';

describe('the colour parser', () => {
  it('reads a hex colour', () => {
    expect(parseColour('#ffffff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColour('#777')).toEqual({ r: 119, g: 119, b: 119, a: 1 });
  });

  it('reads an rgb colour', () => {
    expect(parseColour('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('reads an rgba colour', () => {
    expect(parseColour('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
  });

  it('reads a percentage channel', () => {
    expect(parseColour('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('reads an hsl colour', () => {
    expect(parseColour('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('reads nothing from a word that is not a colour', () => {
    expect(parseColour('var(--color-text)')).toBeUndefined();
    expect(parseColour('none')).toBeUndefined();
  });
});

describe('the contrast ratio', () => {
  it('is 21 for black on white', () => {
    const black = parseColour('#000000');
    const white = parseColour('#ffffff');
    if (black === undefined || white === undefined) throw new Error('the colours must parse');

    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
  });

  it('does not round the ratio it compares', () => {
    const grey = parseColour('#777777');
    const white = parseColour('#ffffff');
    if (grey === undefined || white === undefined) throw new Error('the colours must parse');

    const ratio = contrastRatio(grey, white);

    expect(ratio).toBeLessThan(4.5);
    expect(Math.round(ratio * 10) / 10).toBe(4.5);
  });

  it('is the same whichever way round the pair is given', () => {
    const grey = parseColour('#777777');
    const white = parseColour('#ffffff');
    if (grey === undefined || white === undefined) throw new Error('the colours must parse');

    expect(contrastRatio(grey, white)).toBe(contrastRatio(white, grey));
  });
});

describe('the hue of a colour', () => {
  it('reads purple and blue apart', () => {
    const purple = parseColour('#a855f7');
    const blue = parseColour('#3b82f6');
    if (purple === undefined || blue === undefined) throw new Error('the colours must parse');

    expect(hueOf(purple)).toBeGreaterThan(250);
    expect(hueOf(purple)).toBeLessThan(300);
    expect(hueOf(blue)).toBeGreaterThan(190);
    expect(hueOf(blue)).toBeLessThan(250);
  });
});

describe('the relative luminance', () => {
  it('is one for white', () => {
    const white = parseColour('#ffffff');
    if (white === undefined) throw new Error('the colour must parse');

    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
  });
});
