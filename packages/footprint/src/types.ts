/**
 * A quantity nobody knows exactly, so it carries its bounds.
 *
 * Every number this package produces is an interval, because the inputs are
 * intervals: a model size nobody discloses, a data centre's PUE, a grid's
 * carbon factor. A point estimate would hide that, so the type makes the
 * width impossible to lose.
 */
export type Range = readonly [lo: number, hi: number];

/** An interval, with the ends in order. */
export const r = (lo: number, hi = lo): Range => [Math.min(lo, hi), Math.max(lo, hi)];

/** The sum of two intervals. */
export const add = (a: Range, b: Range): Range => [a[0] + b[0], a[1] + b[1]];

/** The product of two intervals: the four corners, then the two ends. */
export const mul = (a: Range, b: Range): Range => {
  const products = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [Math.min(...products), Math.max(...products)];
};

/** An interval scaled by a number. */
export const scale = (a: Range, k: number): Range => r(a[0] * k, a[1] * k);

export interface ModelArch {
  /** Billions of parameters in total. */
  totalParamsB: Range;
  /**
   * Billions of parameters that take part in one token's forward pass.
   * Equal to the total for a dense model; EcoLogits assumes 10-30 percent
   * activation for a mixture of experts when nobody says.
   */
  activeParamsB: Range;
  source: 'ecologits' | 'model-card' | 'user' | 'unknown';
}

export interface SiteProfile {
  /** Power Usage Effectiveness: the overhead of the data centre. */
  pue: Range;
  /** Litres per kWh, for the cooling inside the data centre. */
  wueOnSite: Range;
  /** Litres per kWh, for the water embedded in the grid electricity. */
  wueOffSite: Range;
  /** Kilograms of CO2 per kWh. */
  gridKgCo2PerKWh: Range;
  /** Where the numbers came from, e.g. "ecologits:anthropic" or "owid:US". */
  source: string;
  /** False when the provider does not disclose its infrastructure. */
  disclosed: boolean;
}

export interface Usage {
  /** Generated tokens. Reasoning tokens count once, not twice. */
  outputTokens: number;
  /** Fresh input tokens. */
  inputTokens: number;
  /** Input tokens read from the cache. */
  cacheReadTokens: number;
  /** Input tokens written to the cache. */
  cacheWriteTokens: number;
  /** The measured request time, when it is known. */
  latencyS?: number;
}

export interface Impact {
  energyWh: Range;
  waterL: Range;
  co2Kg: Range;
  warmingC: Range;
  dominantUncertainty: 'model-size' | 'site' | 'grid' | 'tcre';
  notes: string[];
}

/**
 * The coefficients of the prefill term.
 *
 * The fit is not shipped: the numbers come from ML.ENERGY measurements that
 * a person has to review first, so a caller that wants the term brings its
 * own coefficients. The unit is Wh per token per billion active parameters.
 */
export interface PrefillCoeff {
  kIn: number;
  kCache: number;
}

/** How fast the provider generates, when the numbers are known. */
export interface Throughput {
  /** Time to the first token, in seconds. */
  ttftS: Range;
  /** Tokens per second. */
  tps: Range;
}
