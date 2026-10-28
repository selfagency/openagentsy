import type { PolicyLayer, PolicyModule, PolicyMoment } from '../policy.js';

/**
 * The discovery of the policy modules a plugin brought (§21).
 *
 * A downstream project drops a module into `packages/hooks/src/policies/`
 * and the host loads it. The host cannot trust what it loaded, so the shape
 * is checked here: an id that is not a string, a version that is not a
 * version, or a decision that is not a function is not a policy, and a
 * module that fails the check is not in the stack.
 *
 * A module that came from a plugin is marked `external`, and an external
 * module does not count towards the first-party release criteria.
 */

/** The layers a module may act at. */
const LAYERS: readonly PolicyLayer[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** The moments a module may be checked at. */
const MOMENTS: readonly PolicyMoment[] = [
  'UserPromptSubmit',
  'PreToolCall',
  'PostToolCall',
  'PreResponse',
  'PostResponse',
  'PreCompact',
  'SubagentStop',
];

/** Whether a version is a version. */
export function isSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

/** The record of a candidate, as far as it is one. */
function readCandidate(candidate: unknown): Record<string, unknown> | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return candidate as Record<string, unknown>;
}

/** The id of a candidate. */
function readId(record: Record<string, unknown>): string | undefined {
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return id;
}

/** The version of a candidate. */
function readVersion(record: Record<string, unknown>): string | undefined {
  const version = record['version'];
  if (typeof version !== 'string' || !isSemver(version)) return undefined;
  return version;
}

/** The layer of a candidate. */
function readLayer(record: Record<string, unknown>): PolicyLayer | undefined {
  const layer = record['layer'];
  if (typeof layer !== 'number') return undefined;
  if (!LAYERS.includes(layer as PolicyLayer)) return undefined;
  return layer as PolicyLayer;
}

/** The moments of a candidate. */
function readMoments(record: Record<string, unknown>): PolicyMoment[] | undefined {
  const appliesTo = record['appliesTo'];
  if (!Array.isArray(appliesTo)) return undefined;
  if (!appliesTo.every((moment) => MOMENTS.includes(moment as PolicyMoment))) return undefined;
  return appliesTo as PolicyMoment[];
}

/** The decision of a candidate. */
function readDecision(record: Record<string, unknown>): PolicyModule['evaluate'] | undefined {
  const evaluate = record['evaluate'];
  if (typeof evaluate !== 'function') return undefined;
  return evaluate as PolicyModule['evaluate'];
}

/**
 * The policy a candidate is, when it is one.
 *
 * The candidate is read field by field, and a field that is missing or of
 * the wrong shape makes the whole candidate not a policy: a module that
 * half-loads is worse than a module that does not load at all.
 */
function toPolicyModule(candidate: unknown): PolicyModule | undefined {
  const record = readCandidate(candidate);
  if (record === undefined) return undefined;
  const id = readId(record);
  const version = readVersion(record);
  const layer = readLayer(record);
  const description = record['description'];
  const appliesTo = readMoments(record);
  const evaluate = readDecision(record);
  if (id === undefined) return undefined;
  if (version === undefined) return undefined;
  if (layer === undefined) return undefined;
  if (typeof description !== 'string') return undefined;
  if (appliesTo === undefined) return undefined;
  if (evaluate === undefined) return undefined;
  return {
    id,
    version,
    layer,
    description,
    appliesTo,
    origin: 'external',
    evaluate,
  };
}

/**
 * The policies among the candidates.
 *
 * A candidate that is not a policy is dropped, and the ones that are are
 * marked external unless they say otherwise: a module that came from a
 * plugin is the plugin's, whatever it says about its origin.
 */
export function discoverPolicyModules(candidates: readonly unknown[]): PolicyModule[] {
  const found: PolicyModule[] = [];
  for (const candidate of candidates) {
    const module = toPolicyModule(candidate);
    if (module === undefined) continue;
    found.push(module);
  }
  return found;
}
