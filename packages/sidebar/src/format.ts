import type { Range } from '@openagentsy/footprint';

/**
 * How a block prints a number.
 *
 * Every value the footprint estimator produces is an interval, because the
 * inputs are intervals, and the framing rules say so: a number is shown as a
 * lo-hi range, rounded to two significant figures, and never as a single
 * value. A point estimate would hide the width, and the width is the honest
 * part.
 */

/** The digits a superscript is written with. */
const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '-': '⁻',
};

/** A number rounded to two significant figures, as text. */
function sig2(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (value === 0) return '0';
  return String(Number(value.toPrecision(2)));
}

/**
 * A number as a mantissa with two significant figures.
 *
 * The trailing zero is kept, because a mantissa of two significant figures
 * that ends in a zero says so: five is five and not four.
 */
function mantissa(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (value === 0) return '0.0';
  return value.toPrecision(2);
}

/** The two ends of a range, as text, with a dash between them. */
function ends(lo: string, hi: string): string {
  return lo === hi ? lo : `${lo}–${hi}`;
}

/** An exponent, written as a superscript. */
function superscript(exponent: number): string {
  return String(exponent)
    .split('')
    .map((digit) => SUPERSCRIPT[digit] ?? digit)
    .join('');
}

/** The energy, in watt-hours, or in kilowatt-hours once it is large enough. */
export function fmtWh(range: Range): string {
  const kilo = range[1] >= 1000;
  const scale = kilo ? 1 / 1000 : 1;
  const unit = kilo ? 'kWh' : 'Wh';
  return `${ends(sig2(range[0] * scale), sig2(range[1] * scale))} ${unit}`;
}

/** The water, in litres, or in millilitres while it is small. */
export function fmtL(range: Range): string {
  const litre = range[1] >= 1;
  const scale = litre ? 1 : 1000;
  const unit = litre ? 'L' : 'mL';
  return `${ends(sig2(range[0] * scale), sig2(range[1] * scale))} ${unit}`;
}

/** The carbon, in kilograms, or in grams while it is small. */
export function fmtCo2(range: Range): string {
  const kilo = range[1] >= 1;
  const scale = kilo ? 1 : 1000;
  const unit = kilo ? 'kg' : 'g';
  return `${ends(sig2(range[0] * scale), sig2(range[1] * scale))} ${unit}`;
}

/**
 * A range in scientific notation, the way a warming is written.
 *
 * The exponent is shared by the two ends, so the range reads as one
 * quantity with two bounds: 2.1-5.0 times ten to the minus seventeen.
 */
export function fmtSci(range: Range): string {
  const lo = range[0];
  const hi = range[1];
  if (lo === 0 && hi === 0) return '0';
  const exponent = Math.floor(Math.log10(Math.min(Math.abs(lo), Math.abs(hi))));
  const scale = 10 ** exponent;
  return `${ends(mantissa(lo / scale), mantissa(hi / scale))} × 10${superscript(exponent)}`;
}
