import type { Range } from './types.js';

// EcoLogits LLM inference methodology (CC BY-SA 4.0). https://github.com/mlco2/ecologits
// The formulas below are re-implemented from that methodology; the data
// behind them is not bundled here. See data/SOURCES.md.

/** Wh per token per billion active parameters, at the batch factor. */
export const ALPHA = 1.17e-6;
/** The exponent of the batch factor in the GPU energy regression. */
export const BETA = -1.12e-2;
/** Wh per token, the part that does not scale with the model. */
export const GAMMA = 4.05e-5;
/** Requests the server handles at once, the amortisation factor. */
export const BATCH = 64;
/** kW of the rest of the server, the part that is not a GPU. */
export const W_SERVER_NO_GPU_KW = 1.2;
/** GPUs in one server. */
export const GPUS_INSTALLED = 8;
/** GB of memory on one GPU (an H100 80GB). */
export const GPU_MEM_GB = 80;
/** Bits per weight of the quantised model. */
export const QUANT_BITS = 16;
/** Memory overhead of loading a model, over its raw weights. */
export const MEM_OVERHEAD = 1.2;

/**
 * IPCC AR6 WG1 SPM D.1.1: 0.45 degrees Celsius per 1000 GtCO2, likely
 * between 0.27 and 0.63. 1000 Gt is 1e15 kg.
 */
export const TCRE_C_PER_KG: Range = [0.27e-15, 0.63e-15];
/** The central estimate of the same relation. */
export const TCRE_BEST_C_PER_KG = 0.45e-15;
