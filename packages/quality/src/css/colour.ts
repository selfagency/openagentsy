/**
 * Colours and contrast.
 *
 * The contrast rule needs the ratio of two colours, and the gradient rule
 * needs the hue of a colour, so the parser reads the notations a
 * stylesheet actually uses: hex, `rgb()`, `rgba()`, `hsl()` and `hsla()`.
 */

/** A colour, with the red, green and blue channels from 0 to 255. */
export interface Rgb {
  /** The red channel. */
  r: number;
  /** The green channel. */
  g: number;
  /** The blue channel. */
  b: number;
  /** The alpha, from 0 to 1. */
  a: number;
}

/**
 * Read a colour.
 *
 * The value is a colour, or nothing: a token, a keyword and a name all
 * read as nothing, because a rule that counts them as colours would
 * report every stylesheet.
 */
export function parseColour(value: string): Rgb | undefined {
  const text = value.trim().toLowerCase();
  if (text.startsWith('#')) return parseHex(text);
  if (text.startsWith('rgb')) return parseRgb(text);
  if (text.startsWith('hsl')) return parseHsl(text);
  return undefined;
}

/** A hex colour, with three, four, six or eight digits. */
function parseHex(text: string): Rgb | undefined {
  const digits = text.slice(1);
  if (!/^[0-9a-f]+$/.test(digits)) return undefined;
  if (digits.length === 3 || digits.length === 4) {
    const [r, g, b, a] = [0, 1, 2, 3].map((at) => hexDigit(digits.slice(at, at + 1)));
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return {
      r,
      g,
      b,
      a: a === undefined ? 1 : a / 255,
    };
  }
  if (digits.length === 6 || digits.length === 8) {
    const r = hexPair(digits, 0);
    const g = hexPair(digits, 2);
    const b = hexPair(digits, 4);
    const a = digits.length === 8 ? hexPair(digits, 6) / 255 : 1;
    return { r, g, b, a };
  }
  return undefined;
}

/** One hex digit, as its value from 0 to 255. */
function hexDigit(digit: string): number | undefined {
  if (digit.length === 0) return undefined;
  const value = Number.parseInt(digit + digit, 16);
  return Number.isNaN(value) ? undefined : value;
}

/** Two hex digits, as their value from 0 to 255. */
function hexPair(digits: string, at: number): number {
  return Number.parseInt(digits.slice(at, at + 2), 16);
}

/** An `rgb()` or `rgba()` colour. */
function parseRgb(text: string): Rgb | undefined {
  const body = callBody(text, 'rgb');
  if (body === undefined) return undefined;
  const parts = splitChannels(body);
  if (parts.length < 3) return undefined;
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  if (r === undefined || g === undefined || b === undefined) return undefined;
  const a = parts[3] === undefined ? 1 : alpha(parts[3]);
  if (a === undefined) return undefined;
  return { r, g, b, a };
}

/** An `hsl()` or `hsla()` colour. */
function parseHsl(text: string): Rgb | undefined {
  const body = callBody(text, 'hsl');
  if (body === undefined) return undefined;
  const parts = splitChannels(body);
  if (parts.length < 3) return undefined;
  const hue = number(parts[0]);
  const saturation = percent(parts[1]);
  const lightness = percent(parts[2]);
  if (hue === undefined || saturation === undefined || lightness === undefined) return undefined;
  const a = parts[3] === undefined ? 1 : alpha(parts[3]);
  if (a === undefined) return undefined;
  return { ...hslToRgb(hue, saturation, lightness), a };
}

/** The body of a colour function, or nothing when it is not one. */
function callBody(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}a?\\(([^)]*)\\)$`).exec(text);
  if (match === null) return undefined;
  return match[1];
}

/** The channels of a colour function, in either notation. */
function splitChannels(body: string): string[] {
  return body
    .split(/[,\s/]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** A channel, as a value from 0 to 255. */
function channel(part: string | undefined): number | undefined {
  if (part === undefined) return undefined;
  if (part.endsWith('%')) {
    const percent = number(part.slice(0, -1));
    if (percent === undefined) return undefined;
    return (percent / 100) * 255;
  }
  const value = number(part);
  if (value === undefined) return undefined;
  return Math.min(255, Math.max(0, value));
}

/** A percentage, as a number from 0 to 100. */
function percent(part: string | undefined): number | undefined {
  if (part === undefined) return undefined;
  const text = part.endsWith('%') ? part.slice(0, -1) : part;
  return number(text);
}

/** The alpha of a colour, from 0 to 1. */
function alpha(part: string): number | undefined {
  if (part.endsWith('%')) {
    const value = number(part.slice(0, -1));
    if (value === undefined) return undefined;
    return Math.min(1, Math.max(0, value / 100));
  }
  const value = number(part);
  if (value === undefined) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** A number, or nothing when the text is not one. */
function number(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined;
  return Number.parseFloat(text);
}

/** A colour from a hue, a saturation and a lightness. */
function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const turn = (((hue % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((turn % 2) - 1));
  const m = l - chroma / 2;
  const table: readonly (readonly [number, number, number])[] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  const [r, g, b] = table[Math.floor(turn) % 6] ?? [0, 0, 0];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a: 1,
  };
}

/**
 * The relative luminance of a colour.
 *
 * The channel is linearised the way WCAG 2.2 says, and the result is the
 * luminance the contrast ratio is built on.
 */
export function relativeLuminance(colour: Rgb): number {
  const r = linearise(colour.r / 255);
  const g = linearise(colour.g / 255);
  const b = linearise(colour.b / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** One channel, linearised. */
function linearise(value: number): number {
  if (value <= 0.04045) return value / 12.92;
  return ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * The contrast ratio of two colours.
 *
 * The ratio is not rounded: a pair that is 4.48:1 is under the 4.5:1 of
 * WCAG AA, and a rounded ratio would let it through.
 */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const one = relativeLuminance(first);
  const two = relativeLuminance(second);
  const lighter = Math.max(one, two);
  const darker = Math.min(one, two);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The hue of a colour, in degrees. */
export function hueOf(colour: Rgb): number {
  const r = colour.r / 255;
  const g = colour.g / 255;
  const b = colour.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const hue = 60 * hueTurn(r, g, b, max, delta);
  return ((hue % 360) + 360) % 360;
}

/** Where the hue sits, from the largest channel. */
function hueTurn(r: number, g: number, b: number, max: number, delta: number): number {
  if (max === r) return ((g - b) / delta) % 6;
  if (max === g) return (b - r) / delta + 2;
  return (r - g) / delta + 4;
}
