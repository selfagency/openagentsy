#!/usr/bin/env node
/**
 * The derivation of the prefill coefficients.
 *
 * The prefill term of the plan is `E_prefill = k_in·P_active·T_in +
 * k_cache·P_active·T_cache_read`. This script fits `k_in` from the
 * measurements of the ML.ENERGY Benchmark and writes the fit, with its
 * provenance, into `data/prefill-fit.json`.
 *
 * It runs in two steps, and the second one is offline:
 *
 *   node scripts/fit-prefill.mjs --fetch   fetch the source, write the
 *                                         snapshot, then fit it
 *   node scripts/fit-prefill.mjs           fit the committed snapshot
 *
 * The snapshot (`data/prefill-measurements.json`) is committed, so the fit is
 * reproducible without a network, and so a reviewer can see the raw numbers
 * the coefficients came from.
 *
 * The source is Table 4 of "The ML.ENERGY Benchmark: Toward Automated
 * Inference Energy Measurement and Optimization" (arXiv:2505.06371). The table
 * reports, for a prefill/decode disaggregated deployment, the energy of one
 * generation and the share of it that the decode phase consumed. What is left
 * is the energy of the prefill phase, and the table names the mean input
 * length of the request dataset, so each row is a measurement of prefill
 * energy against a known number of input tokens and a known model size.
 *
 * The fit does not ship enabled. `footprint.prefill` stays false, and the
 * package never reads this file at runtime: a caller who wants the term
 * passes the coefficients in.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '..', 'data');
const SNAPSHOT_PATH = resolve(DATA, 'prefill-measurements.json');
const FIT_PATH = resolve(DATA, 'prefill-fit.json');
/** The repository's formatter, so the file the script writes is the file the repository keeps. */
const BIOME = resolve(HERE, '..', '..', '..', 'node_modules', '.bin', 'biome');

/** The rendered paper, which carries Table 4. */
const PAPER_HTML = 'https://arxiv.org/html/2505.06371';
/** The landing page, which carries the citation. */
const PAPER_ABS = 'https://arxiv.org/abs/2505.06371';
/** Joules in a watt-hour. The package counts in watt-hours. */
const JOULES_PER_WATT_HOUR = 3600;
/**
 * The share of the fresh-input cost that a cache read is assumed to carry.
 *
 * A cached token skips the model's forward pass, so what is left is the
 * attention over the cache, which is far cheaper than the compute. The
 * fraction is a modelling assumption, not a measurement: no ML.ENERGY run
 * measures a cache read. The ratio is the one the major providers charge for
 * a cache read against a fresh input token, which is a proxy for the
 * compute it avoids.
 */
const CACHE_FRACTION_OF_IN = 0.1;

/** The text of a rendered HTML page, without the markup. */
function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#37;/g, '%')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** The request datasets of the table: the mean input and output length of each column. */
function parseColumns(text) {
  const header =
    /Input mean (\d+) Output mean (\d+)(?: Input mean (\d+) Output mean (\d+))?(?: Input mean (\d+) Output mean (\d+))?/.exec(
      text,
    );
  if (!header) throw new Error('the paper carries no Table 4 header');
  const columns = [];
  for (let i = 1; i < header.length; i += 2) {
    if (!header[i]) continue;
    columns.push({ inputMeanTokens: Number(header[i]), outputMeanTokens: Number(header[i + 1]) });
  }
  return columns;
}

/** The cells of one row: the energy of a generation, and the share the decode phase took. */
function parseCells(text) {
  const cells = [];
  for (const cell of text.matchAll(/(\d+\.\d+), (\d+\.\d+)%/g)) {
    cells.push({
      energyPerGenerationJ: Number(cell[1]),
      decodeEnergyShare: Number(cell[2]) / 100,
    });
  }
  return cells;
}

/**
 * The measurements of Table 4, out of the rendered paper.
 *
 * Every row is a deployment of one model; every cell is a request dataset
 * with a mean input length, the energy of one generation in joules, and the
 * share of that energy the decode phase consumed.
 */
function parseTable4(text) {
  const columns = parseColumns(text);

  const rows = [];
  const rowPattern = /Llama 3\.1 (\d+)B \(TP=(\d+), (\d+P\d+D)\)((?: \d+\.\d+, \d+\.\d%)+)/g;
  for (const match of text.matchAll(rowPattern)) {
    const cells = parseCells(match[4]);
    if (cells.length !== columns.length) {
      throw new Error(
        `row ${match[0]} carries ${cells.length} cells, the table has ${columns.length}`,
      );
    }
    rows.push({
      model: `Llama 3.1 ${match[1]}B`,
      activeParamsBillions: Number(match[1]),
      deployment: `TP=${match[2]}, ${match[3]}`,
      cells,
    });
  }
  if (rows.length === 0) throw new Error('the paper carries no Table 4 rows');
  return { columns, rows };
}

/** Write a data file, and let the repository's formatter have the last word on it. */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  try {
    execFileSync(BIOME, ['format', '--write', path], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`the formatter could not format ${path}: ${error.message}`);
  }
}

/** Fetch the paper, parse Table 4, and write the snapshot. */
async function fetchSnapshot() {
  const response = await fetch(PAPER_HTML);
  if (!response.ok) {
    throw new Error(`fetching ${PAPER_HTML} failed with ${response.status}`);
  }
  const text = stripTags(await response.text());
  const { columns, rows } = parseTable4(text);
  const snapshot = {
    source: {
      id: 'arXiv:2505.06371',
      title:
        'The ML.ENERGY Benchmark: Toward Automated Inference Energy Measurement and Optimization',
      table: 'Table 4, Appendix B.3 (prefill-decode disaggregation)',
      url: PAPER_ABS,
      html: PAPER_HTML,
      fetched_at: new Date().toISOString().slice(0, 10),
      what_the_numbers_are:
        'energy of one generation in joules, and the share of that energy the decode phase consumed',
    },
    columns,
    rows,
  };
  writeJson(SNAPSHOT_PATH, snapshot);
  return snapshot;
}

/** Read the committed snapshot. */
function readSnapshot() {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
}

/**
 * The fit.
 *
 * The model is proportional: the prefill energy of a request is the number of
 * input tokens times the number of active parameters times one coefficient.
 * The least-squares fit of a proportional model goes through the origin, and
 * that is the fit: `k = Σxy / Σx²`, with `x` the product of the active
 * parameters and the input tokens, and `y` the prefill energy of the request.
 *
 * The fit through the origin is checked against the fit with a free
 * intercept: the intercept says how much energy a request would cost with no
 * input tokens at all, and it is small next to the energy a request costs, so
 * the origin is the right place to pin it.
 */
function fit(snapshot) {
  const points = [];
  for (const row of snapshot.rows) {
    row.cells.forEach((cell, index) => {
      const column = snapshot.columns[index];
      const prefillJ = cell.energyPerGenerationJ * (1 - cell.decodeEnergyShare);
      const x = row.activeParamsBillions * column.inputMeanTokens;
      points.push({
        model: row.model,
        deployment: row.deployment,
        activeParamsBillions: row.activeParamsBillillions,
        inputMeanTokens: column.inputMeanTokens,
        outputMeanTokens: column.outputMeanTokens,
        energyPerGenerationJ: cell.energyPerGenerationJ,
        decodeEnergyShare: cell.decodeEnergyShare,
        prefillEnergyPerRequestJ: prefillJ,
        x,
        y: prefillJ,
      });
    });
  }

  const sumXy = points.reduce((sum, p) => sum + p.x * p.y, 0);
  const sumXx = points.reduce((sum, p) => sum + p.x * p.x, 0);
  const kJoules = sumXy / sumXx;

  const sumY = points.reduce((sum, p) => sum + p.y, 0);
  const sumX = points.reduce((sum, p) => sum + p.x, 0);
  const n = points.length;
  const slope = (n * sumXy - sumX * sumY) / (n * sumXx - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  const ratios = points.map((p) => p.y / p.x);
  const residuals = points.map((p) => ({
    ...p,
    predictedPrefillJ: kJoules * p.x,
    relativeResidual: (p.y - kJoules * p.x) / p.y,
    ratioJ: p.y / p.x,
  }));
  const rmsRelativeResidual = Math.sqrt(
    residuals.reduce((sum, p) => sum + p.relativeResidual ** 2, 0) / n,
  );

  const kInWh = kJoules / JOULES_PER_WATT_HOUR;
  const rangeWh = [Math.min(...ratios), Math.max(...ratios)].map((v) => v / JOULES_PER_WATT_HOUR);

  return {
    kInWh,
    rangeWh,
    kCacheWh: kInWh * CACHE_FRACTION_OF_IN,
    kCacheRangeWh: rangeWh.map((v) => v * CACHE_FRACTION_OF_IN),
    diagnostics: {
      points: n,
      fit_through_origin_joules: kJoules,
      fit_with_intercept: { slope_joules: slope, intercept_joules: intercept },
      ratio_mean_joules: ratios.reduce((a, b) => a + b, 0) / n,
      rms_relative_residual: rmsRelativeResidual,
      max_relative_residual: Math.max(...residuals.map((p) => Math.abs(p.relativeResidual))),
      residuals,
    },
  };
}

/** The fit file, with the provenance the review needs. */
function fitFile(snapshot, result) {
  const source = snapshot.source;
  const unit = 'watt-hour per input token per billion active parameters';
  return {
    k_in: {
      value: result.kInWh,
      unit,
      source: `${source.id} (${source.title}), ${source.table}: ${source.what_the_numbers_are}`,
      fittedOn: source.fetched_at,
      range: result.rangeWh,
    },
    k_cache: {
      value: result.kCacheWh,
      unit: 'watt-hour per cache-read token per billion active parameters',
      source: `${CACHE_FRACTION_OF_IN} of k_in, as a modelling assumption: a cache read skips the model's forward pass. No ML.ENERGY run measures a cache read.`,
      fittedOn: source.fetched_at,
      range: result.kCacheRangeWh,
    },
    method: [
      'The prefill energy of a request is the energy of the generation minus the share the decode phase consumed (the table gives that share), so every cell of the source table is one measurement of prefill energy against a known input length and a known model size.',
      'The model is proportional: E_prefill = k_in · P_active · T_in. The least-squares fit of a proportional model goes through the origin, so k_in = Σ(x·y) / Σ(x²), with x = P_active (in billions) × T_in (tokens) and y the prefill energy of one request in joules.',
      'The joules are divided by 3600, because the package counts in watt-hours.',
      `The fit with a free intercept puts the intercept at ${result.diagnostics.fit_with_intercept.intercept_joules.toFixed(2)} J, small next to the energy of a request, so the origin is where the fit belongs.`,
      `The residual RMS is ${(result.diagnostics.rms_relative_residual * 100).toFixed(1)} percent, and the worst point is ${(result.diagnostics.max_relative_residual * 100).toFixed(1)} percent off.`,
      'The range is the span of the per-point ratios (prefill energy divided by P_active × T_in), which spans the two model sizes measured: the coefficient is larger for the bigger model, because the fit is a single number for models that differ.',
    ],
    data_source: {
      id: source.id,
      title: source.title,
      table: source.table,
      url: source.url,
      snapshot: 'packages/footprint/data/prefill-measurements.json',
      derivation: 'packages/footprint/scripts/fit-prefill.mjs',
      measurements: result.diagnostics.points,
      fitted_models: snapshot.rows.map((r) => r.model),
      note: 'The Hugging Face dataset of the benchmark (ml-energy/benchmark-v3) is gated and was not readable, and the leaderboard of version 3 carries no prefill column, so the measurements come from the paper.',
    },
    diagnostics: {
      measurements: result.diagnostics.points,
      residual_rms: result.diagnostics.rms_relative_residual,
      worst_relative_residual: result.diagnostics.max_relative_residual,
      ratio_mean_joules: result.diagnostics.ratio_mean_joules,
      fit_through_origin_joules: result.diagnostics.fit_through_origin_joules,
      fit_with_intercept: result.diagnostics.fit_with_intercept,
      residuals: result.diagnostics.residuals.map((p) => ({
        model: p.model,
        deployment: p.deployment,
        active_params_billions: p.activeParamsBillions,
        input_mean_tokens: p.inputMeanTokens,
        output_mean_tokens: p.outputMeanTokens,
        energy_per_generation_j: p.energyPerGenerationJ,
        decode_energy_share: p.decodeEnergyShare,
        prefill_energy_per_request_j: p.prefillEnergyPerRequestJ,
        predicted_prefill_j: p.predictedPrefillJ,
        relative_residual: p.relativeResidual,
      })),
    },
    notes: [
      'This fit does not ship enabled. footprint.prefill stays false, and the package never reads this file: a caller who wants the term passes the coefficients in.',
      'The unit is watt-hours per token per billion active parameters, the same unit as the EcoLogits per-token coefficient in src/constants.ts.',
      'The measured models are dense, so the active parameters are the total parameters.',
      'The measurements are per generation of a served request. The prefill of a batched request is compute-bound, so the batching does not amorten it the way it amortens the decode phase; the deployments differ in how many prefill and decode instances they ran, which is part of what the range covers.',
    ],
  };
}

/** Fit the committed snapshot and write the fit file. */
function runFit() {
  const snapshot = readSnapshot();
  const result = fit(snapshot);
  writeJson(FIT_PATH, fitFile(snapshot, result));
  const d = result.diagnostics;
  process.stdout.write(
    [
      `k_in  = ${result.kInWh.toExponential(6)} Wh/token/B (range ${result.rangeWh[0].toExponential(6)} .. ${result.rangeWh[1].toExponential(6)})`,
      `k_cache = ${result.kCacheWh.toExponential(6)} Wh/token/B`,
      `points = ${d.points}, residual RMS = ${(d.rms_relative_residual * 100).toFixed(1)}%, worst = ${(d.max_relative_residual * 100).toFixed(1)}%`,
      `wrote ${FIT_PATH}`,
    ].join('\n'),
  );
}

if (process.argv.includes('--fetch')) {
  const snapshot = await fetchSnapshot();
  process.stdout.write(`fetched ${snapshot.rows.length} rows, wrote ${SNAPSHOT_PATH}\n`);
}
runFit();
