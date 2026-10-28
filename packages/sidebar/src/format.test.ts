import { describe, expect, it } from 'vitest';
import { fmtCo2, fmtL, fmtSci, fmtWh } from './format.js';

/**
 * The printing rules.
 *
 * A number the estimator produces is an interval, and the rules say how an
 * interval is written: as a range, rounded to two significant figures, in
 * the unit that fits it.
 */
describe('the printing rules', () => {
  it('switches between watt-hours and kilowatt-hours', () => {
    expect(fmtWh([2.34, 2.71])).toBe('2.3–2.7 Wh');
    expect(fmtWh([2340, 2710])).toBe('2.3–2.7 kWh');
  });

  it('switches between millilitres and litres', () => {
    expect(fmtL([0.0026, 0.0078])).toBe('2.6–7.8 mL');
    expect(fmtL([2.6, 7.8])).toBe('2.6–7.8 L');
  });

  it('switches between grams and kilograms', () => {
    expect(fmtCo2([0.00092, 0.0016])).toBe('0.92–1.6 g');
    expect(fmtCo2([0.92, 1.6])).toBe('0.92–1.6 kg');
  });

  it('writes a warming in scientific notation', () => {
    expect(fmtSci([2.5e-19, 1e-18])).toBe('2.5–10 × 10⁻¹⁹');
  });

  it('rounds to two significant figures', () => {
    expect(fmtWh([1.234, 5.678])).toBe('1.2–5.7 Wh');
  });

  it('shows a single value when the two ends are the same', () => {
    expect(fmtWh([2.5, 2.5])).toBe('2.5 Wh');
  });
});
