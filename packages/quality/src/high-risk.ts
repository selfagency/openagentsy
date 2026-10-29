import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The high-risk classifier.
 *
 * It reads a piece of prose — a commit message, a pull-request
 * description, a code comment, a task summary, a status report — and says
 * which of the eight high-risk domains it touches.
 *
 * The classifier is a keyword and regex list. It is a heuristic, and it
 * says so here because the alternative is a false promise: it will miss a
 * high-risk phrase that is worded differently, and it will fire on
 * ordinary prose that happens to carry one of the words. A false negative
 * is the worse of the two, so the caller treats a firing as a reason for a
 * person to look, not as a verdict.
 *
 * The keyword list lives in `data/high-risk-keywords.json` and carries a
 * version, so a change to it is visible in a diff and in the record.
 */

/** The eight high-risk domains. */
export type HighRiskDomain =
  | 'self-harm'
  | 'abuse'
  | 'advice'
  | 'crime'
  | 'persuasion'
  | 'relational'
  | 'automated-decision'
  | 'civic';

/** The domains, in the order the framework lists them. */
export const HIGH_RISK_DOMAINS: readonly HighRiskDomain[] = [
  'self-harm',
  'abuse',
  'advice',
  'crime',
  'persuasion',
  'relational',
  'automated-decision',
  'civic',
];

/**
 * The confidence a domain needs before the caller tightens the rules.
 *
 * A domain below this threshold is reported as a match but does not
 * change anything.
 */
export const HIGH_RISK_CONFIDENCE_THRESHOLD = 0.6;

/** The weight of a phrase that names the domain outright. */
const STRONG_WEIGHT = 0.6;

/** The weight of a phrase that suggests the domain. */
const PHRASE_WEIGHT = 0.35;

/** One domain of the keyword list. */
const domainSchema = z.object({
  label: z.string(),
  stakeholder: z.string(),
  phrases: z.array(z.string()),
  strong: z.array(z.string()),
  patterns: z.array(z.object({ pattern: z.string(), weight: z.number() })),
  thresholds: z.object({
    sycophancy: z.number(),
    professionalDisplacement: z.number(),
    scopeDrift: z.number(),
  }),
});

/** The whole keyword list. */
const keywordListSchema = z.object({
  version: z.string(),
  domains: z.record(z.string(), domainSchema),
});

/** One domain of the keyword list, as it is used. */
interface DomainEntry {
  label: string;
  stakeholder: string;
  phrases: readonly string[];
  strong: readonly string[];
  patterns: { pattern: string; weight: number; expression: RegExp }[];
  thresholds: DetectorThresholds;
}

/** The thresholds of the three output detectors. */
export interface DetectorThresholds {
  /** The confidence the sycophancy detector needs before it fires. */
  sycophancy: number;
  /** The confidence the professional-displacement detector needs. */
  professionalDisplacement: number;
  /** The confidence the scope-drift detector needs. */
  scopeDrift: number;
}

/**
 * The thresholds the detectors use when nothing else says otherwise.
 *
 * The three detectors fire on the first match today, so the baseline is a
 * confidence cut of the same size as the high-risk one, and the high-risk
 * cut is the lower of the two.
 */
export const BASELINE_DETECTOR_THRESHOLDS: DetectorThresholds = {
  sycophancy: 0.6,
  professionalDisplacement: 0.6,
  scopeDrift: 0.6,
};

/** The keyword list, loaded once and kept. */
interface KeywordList {
  version: string;
  domains: Map<HighRiskDomain, DomainEntry>;
}

/**
 * Where the keyword list can be.
 *
 * The list is a data file, so `tsc` does not copy it into the build: it
 * stays beside the sources and beside the build output, and the first
 * path that exists is the one that is read. The last two paths are for
 * the case where the package is bundled into the plugin, where the path
 * of this module says nothing about where the data ended up.
 */
const KEYWORD_PATHS: readonly string[] = [
  fileURLToPath(new URL('../data/high-risk-keywords.json', import.meta.url)),
  fileURLToPath(new URL('./data/high-risk-keywords.json', import.meta.url)),
  join(process.cwd(), 'node_modules/@openagentsy/quality/data/high-risk-keywords.json'),
  join(process.cwd(), 'packages/quality/data/high-risk-keywords.json'),
];

/** The loaded keyword list, or nothing when it has not been read yet. */
let loaded: KeywordList | undefined;

/**
 * The keyword list, read from the data directory.
 *
 * A missing or malformed file is an error and is not swallowed: a
 * classifier that silently matched nothing would report every reply as
 * safe.
 */
function keywordList(): KeywordList {
  if (loaded !== undefined) return loaded;
  const path = KEYWORD_PATHS.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new Error(
      `the high-risk keyword list is not at any of these paths: ${KEYWORD_PATHS.join(', ')}`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the high-risk keyword list is not valid JSON: ${describe(error)}`);
  }
  const result = keywordListSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `the high-risk keyword list is not the expected shape: ${result.error.message}`,
    );
  }
  const domains = new Map<HighRiskDomain, DomainEntry>();
  for (const domain of HIGH_RISK_DOMAINS) {
    const entry = result.data.domains[domain];
    if (entry === undefined) {
      throw new Error(`the high-risk keyword list has no domain ${domain}`);
    }
    domains.set(domain, {
      label: entry.label,
      stakeholder: entry.stakeholder,
      phrases: entry.phrases,
      strong: entry.strong,
      patterns: entry.patterns.map((pattern) => ({
        pattern: pattern.pattern,
        weight: pattern.weight,
        expression: new RegExp(pattern.pattern, 'iu'),
      })),
      thresholds: entry.thresholds,
    });
  }
  loaded = { version: result.data.version, domains };
  return loaded;
}

/** The message of an error, without its stack. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the classifier found in one domain. */
export interface HighRiskMatch {
  /** The domain the prose touches. */
  domain: HighRiskDomain;
  /** How sure the classifier is, from 0 to 1. */
  confidence: number;
  /** The phrases and patterns that matched. */
  evidence: readonly string[];
}

/** What the classifier found in a piece of prose. */
export interface HighRiskClassification {
  /** Every domain with evidence, the surest first. */
  matches: readonly HighRiskMatch[];
  /** The surest domain, when it is surer than the threshold. */
  highest?: HighRiskMatch;
  /** The version of the keyword list that decided it. */
  version: string;
}

/**
 * The highest-confidence domain, when it is at least the threshold.
 *
 * The threshold is inclusive: a domain at exactly 0.6 is a domain.
 */
export function highestHighRiskMatch(matches: readonly HighRiskMatch[]): HighRiskMatch | undefined {
  let best: HighRiskMatch | undefined;
  for (const match of matches) {
    if (best === undefined || match.confidence > best.confidence) best = match;
  }
  if (best === undefined) return undefined;
  if (best.confidence < HIGH_RISK_CONFIDENCE_THRESHOLD) return undefined;
  return best;
}

/**
 * Classify a piece of prose.
 *
 * The prose is matched against every domain of the keyword list. A domain
 * with evidence is a match, whatever its confidence; the caller decides
 * what to do with a domain below the threshold.
 */
export function classifyHighRisk(text: string): HighRiskClassification {
  const list = keywordList();
  if (text.trim() === '') return { matches: [], version: list.version };
  const haystack = text.toLowerCase();
  const matches: HighRiskMatch[] = [];
  for (const domain of HIGH_RISK_DOMAINS) {
    const entry = list.domains.get(domain);
    if (entry === undefined) continue;
    const found = evidenceIn(entry, haystack, text);
    if (found.evidence.length === 0) continue;
    matches.push({
      domain,
      confidence: Math.min(1, found.weight),
      evidence: found.evidence,
    });
  }
  matches.sort((left, right) => {
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return left.domain.localeCompare(right.domain);
  });
  const highest = highestHighRiskMatch(matches);
  return highest === undefined
    ? { matches, version: list.version }
    : { matches, highest, version: list.version };
}

/** The evidence of one domain, and its weight. */
function evidenceIn(
  entry: DomainEntry,
  haystack: string,
  text: string,
): { evidence: string[]; weight: number } {
  const evidence: string[] = [];
  const seen = new Set<string>();
  let weight = 0;
  const add = (value: string, value2: number): void => {
    if (seen.has(value)) return;
    seen.add(value);
    evidence.push(value);
    weight += value2;
  };
  for (const phrase of entry.strong) {
    if (!haystack.includes(phrase)) continue;
    add(phrase, STRONG_WEIGHT);
  }
  for (const phrase of entry.phrases) {
    if (!haystack.includes(phrase)) continue;
    add(phrase, PHRASE_WEIGHT);
  }
  for (const pattern of entry.patterns) {
    const match = pattern.expression.exec(text);
    if (match === null) continue;
    add(match[0], pattern.weight);
  }
  return { evidence, weight };
}

/** The label and the stakeholder of a domain. */
export interface HighRiskDomainCopy {
  /** What the domain is called in the copy. */
  label: string;
  /** Who the copy has to name as the one affected. */
  stakeholder: string;
}

/**
 * The label and the stakeholder of a domain.
 *
 * They come from the keyword list, so the copy and the classifier cannot
 * drift apart.
 */
export function highRiskDomainCopy(domain: HighRiskDomain): HighRiskDomainCopy {
  const entry = keywordList().domains.get(domain);
  if (entry === undefined) throw new Error(`the high-risk keyword list has no domain ${domain}`);
  return { label: entry.label, stakeholder: entry.stakeholder };
}

/**
 * The policy id the caller writes in the ledger.
 *
 * The id names the domain, so a ledger of policy ids says which domains
 * the agent worked in without reading the prose.
 */
export function highRiskPolicyId(domain: HighRiskDomain): string {
  return `oa.high-risk.${domain}`;
}

/**
 * The lowered thresholds of the three output detectors.
 *
 * The thresholds are confidence cuts: a detector fires when the
 * confidence of its evidence is at least the threshold. A high-risk
 * domain lowers all three, so the same words that are a warning
 * elsewhere become a finding here.
 */
export function loweredThresholds(domain: HighRiskDomain): DetectorThresholds {
  const entry = keywordList().domains.get(domain);
  if (entry === undefined) throw new Error(`the high-risk keyword list has no domain ${domain}`);
  return entry.thresholds;
}

/** The surfaces the classifier can read. */
export type HighRiskSurface =
  | 'commit-message'
  | 'pr-description'
  | 'task-summary'
  | 'status-report'
  | 'code-comment';

/** The extensions a source file has. */
const SOURCE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'php',
  'sh',
  'sql',
];

/**
 * The surface a path belongs to.
 *
 * The caller reports where the classifier fired, so a person can look at
 * the commit message rather than at the repository. A path the detector
 * cannot place is reported as a status report: it is prose, and it is not
 * a commit, a pull request, a task summary or a source file.
 */
export function detectSurface(path: string): HighRiskSurface {
  const lower = path.toLowerCase();
  if (/commit[-_]?(?:editmsg|msg)/.test(lower)) return 'commit-message';
  if (/pull[-_]?request|pr[-_]?description/.test(lower)) return 'pr-description';
  const segments = lower.split(/[\\/]/);
  const hasTask = segments.some((segment) => segment.startsWith('task'));
  const hasSummary = segments.some((segment) => segment.startsWith('summary'));
  if (hasTask && hasSummary) return 'task-summary';
  const hasStatus = segments.some((segment) => segment.startsWith('status'));
  const hasReport = segments.some((segment) => segment.startsWith('report'));
  if (hasStatus && hasReport) return 'status-report';
  if (SOURCE_EXTENSIONS.includes(extensionOf(lower))) return 'code-comment';
  return 'status-report';
}

/** The extension of a path, without the dot. */
function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot === -1) return '';
  return name.slice(dot + 1);
}

/**
 * The accountability line the caller writes.
 *
 * It says what fired, where it fired and what changed, in one line.
 */
export function accountabilityLine(domain: HighRiskDomain, surface: HighRiskSurface): string {
  return `high-risk domain ${domain} detected in ${surface}; copy rules tightened`;
}
