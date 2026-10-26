import {
  ALPHA,
  BATCH,
  BETA,
  GAMMA,
  GPU_MEM_GB,
  GPUS_INSTALLED,
  MEM_OVERHEAD,
  QUANT_BITS,
  TCRE_C_PER_KG,
  W_SERVER_NO_GPU_KW,
} from './constants.js';
import {
  add,
  type Impact,
  type ModelArch,
  mul,
  type PrefillCoeff,
  type Range,
  r,
  type SiteProfile,
  scale,
  type Throughput,
  type Usage,
} from './types.js';

/**
 * The energy of one output token on one GPU, in Wh.
 *
 * The EcoLogits regression: a part that scales with the active parameters of
 * the model and a part that does not, both divided by the number of requests
 * the server handles at once.
 */
export const energyPerToken = (activeParamsB: number): number =>
  ALPHA * Math.exp(BETA * BATCH) * activeParamsB + GAMMA;

/**
 * How many GPUs the model needs to sit in memory.
 *
 * The count is monotone in the model size, and it doubles rather than
 * creeping, because a server holds eight GPUs and a model is not split
 * across a fraction of one.
 */
export function gpuCount(totalParamsB: number): number {
  const memGB = (MEM_OVERHEAD * totalParamsB * 1e9 * QUANT_BITS) / 8 / 1e9;
  const needed = Math.max(1, Math.ceil(memGB / GPU_MEM_GB));
  return 2 ** Math.ceil(Math.log2(needed));
}

/** Where the energy of a request went. */
export interface RemoteBreakdown {
  /** What the GPUs spent. */
  gpuWh: Range;
  /** What the rest of the server spent, over the generation time. */
  restWh: Range;
  /** The IT energy, before the data centre overhead and the prefill term. */
  serverWh: Range;
}

/** The prefill term is an OpenAgentsy extension, and it is off by default. */
function prefillWh(usage: Usage, arch: ModelArch, coeff: PrefillCoeff): Range {
  const perActiveB = coeff.kIn * usage.inputTokens + coeff.kCache * usage.cacheReadTokens;
  return scale(arch.activeParamsB, perActiveB);
}

/**
 * The energy of a request against a remote provider, before the data centre.
 *
 * The GPU count and the per-token energy are both intervals, so the estimate
 * is an interval too. The bounds come from the corners of those intervals,
 * which is where the energy is largest and smallest.
 */
export function remoteEnergyBreakdown(
  usage: Usage,
  arch: ModelArch,
  throughput: Throughput,
  opts: { prefill?: PrefillCoeff } = {},
): RemoteBreakdown {
  const gpus = r(gpuCount(arch.totalParamsB[0]), gpuCount(arch.totalParamsB[1]));
  const perToken = r(energyPerToken(arch.activeParamsB[0]), energyPerToken(arch.activeParamsB[1]));
  const gpuWh = mul(scale(perToken, usage.outputTokens), gpus);

  const generation = r(
    throughput.ttftS[0] + usage.outputTokens / throughput.tps[1],
    throughput.ttftS[1] + usage.outputTokens / throughput.tps[0],
  );
  const dt = usage.latencyS
    ? r(Math.min(generation[0], usage.latencyS), Math.min(generation[1], usage.latencyS))
    : generation;
  const restWh = scale(
    mul(dt, scale(gpus, 1 / GPUS_INSTALLED)),
    (W_SERVER_NO_GPU_KW * 1000) / 3600 / BATCH,
  );

  let serverWh = add(gpuWh, restWh);
  if (opts.prefill) {
    serverWh = add(serverWh, prefillWh(usage, arch, opts.prefill));
  }

  return { gpuWh, restWh, serverWh };
}

/**
 * The impact of a request against a remote provider.
 *
 * The energy is the data centre's, so the PUE is applied to it, and the
 * water is the cooling inside the data centre plus the water embedded in
 * the electricity that powered it.
 */
export function estimateRemote(
  usage: Usage,
  arch: ModelArch,
  site: SiteProfile,
  throughput: Throughput,
  opts: { prefill?: PrefillCoeff } = {},
): Impact {
  const notes = ['output tokens only (EcoLogits method)'];
  const { serverWh: eServer } = remoteEnergyBreakdown(usage, arch, throughput, opts);
  if (opts.prefill) {
    notes.push('prefill term on (OpenAgentsy extension, not EcoLogits)');
  }

  const energyWh = mul(eServer, site.pue);
  const kWhServer = scale(eServer, 1 / 1000);
  const waterL = add(
    mul(kWhServer, site.wueOnSite),
    mul(mul(kWhServer, site.pue), site.wueOffSite),
  );
  const co2Kg = mul(scale(energyWh, 1 / 1000), site.gridKgCo2PerKWh);
  const warmingC = mul(co2Kg, TCRE_C_PER_KG);

  return {
    energyWh,
    waterL,
    co2Kg,
    warmingC,
    dominantUncertainty: dominant(arch, site),
    notes,
  };
}

/**
 * The impact of a request against a local runtime (Ollama, LM Studio).
 *
 * The time and the power of the device are the whole estimate, and there is
 * no data centre, so there is no cooling water.
 */
export function estimateLocal(seconds: number, deviceWatts: Range, grid: SiteProfile): Impact {
  const energyWh = scale(deviceWatts, seconds / 3600);
  const kWh = scale(energyWh, 1 / 1000);
  return {
    energyWh,
    waterL: mul(kWh, grid.wueOffSite),
    co2Kg: mul(kWh, grid.gridKgCo2PerKWh),
    warmingC: mul(mul(kWh, grid.gridKgCo2PerKWh), TCRE_C_PER_KG),
    dominantUncertainty: 'grid',
    notes: ['local device estimate: configured watts x generation time'],
  };
}

/**
 * Which input the answer leans on hardest.
 *
 * The width of an interval, relative to its low end, is what decides this.
 * The three inputs that can widen the answer are the model size, the site
 * and the grid.
 */
function dominant(arch: ModelArch, site: SiteProfile): Impact['dominantUncertainty'] {
  const width = (x: Range): number => (x[1] - x[0]) / Math.max(x[0], 1e-12);
  const scores: Record<string, number> = {
    'model-size': width(arch.totalParamsB),
    site: width(site.pue) + width(site.wueOnSite),
    grid: width(site.gridKgCo2PerKWh),
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  return (top ? top[0] : 'model-size') as Impact['dominantUncertainty'];
}
