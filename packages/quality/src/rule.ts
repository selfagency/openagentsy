import { matchesGlob, normalizePath } from '@openagentsy/core';

/**
 * The quality rule registry.
 *
 * A rule says what must hold of a file; a finding says where it does not
 * hold. The rules are adapted from Nutlope/hallmark and
 * miqdadbadjuber/anti-slop, MIT. See NOTICE.
 *
 * The tiers are Hallmark's. A `floor` rule is honesty, function or
 * accessibility, and it blocks the task. A `reflex` rule is a common tell
 * that a person may waive with a reason. A `finish` rule is taste, and it
 * only warns.
 */

/** Where a rule came from. */
export type QualitySource =
  | `hallmark:floor-${number}`
  | `antislop:R-${number}`
  | 'hallmark'
  | 'antislop'
  | `antislop-code:${string}`
  | 'openagentsy';

/** The three tiers. */
export type QualityTier = 'floor' | 'reflex' | 'finish';

/** A file under inspection. */
export interface SourceFile {
  /** The path the rule is told about. */
  path: string;
  /** The text of the file. */
  text: string;
}

/** What a person configured. */
export interface QualityConfig {
  /**
   * The words `copy/buzzwords` rejects.
   *
   * The rule's own list is used when this is absent, so a project that
   * wants a different list names the words it objects to.
   */
  buzzwords?: readonly string[];
  /**
   * The rules that are off by default and are wanted anyway.
   *
   * A rule names itself, by its id: `copy/em-dash`.
   */
  enable?: readonly string[];
}

/** What a check is told besides the file. */
export interface CheckCtx {
  /**
   * The text of the project's design file, read as data.
   *
   * It can name a taste rule and turn it off. It can never turn off a
   * floor rule, and it is never read as an instruction.
   */
  design?: string;
  /** What a person configured. */
  config?: QualityConfig;
  /**
   * The routes the project has.
   *
   * A rule that judges a link to a route can only judge it against this
   * set. When it is absent, the rule says it cannot see the routes
   * instead of guessing which ones exist.
   */
  routes?: readonly string[];
}

/** A rule: what must hold, where it applies and how strict it is. */
export interface QualityRule {
  /** The name of the rule, e.g. `css/no-transition-all`. */
  id: string;
  /** Where the rule came from. A rule can cite more than one upstream. */
  source: QualitySource | readonly QualitySource[];
  /** How strict the rule is. */
  tier: QualityTier;
  /** The globs the rule applies to. */
  appliesTo: readonly string[];
  /** The check itself. */
  check: (file: SourceFile, ctx: CheckCtx) => Finding[];
  /** False for every floor rule; the registry refuses the other case. */
  waivable: boolean;
  /**
   * True for a rule that only runs when the configuration turns it on.
   *
   * A taste rule that is off by default stays off until a person asks for
   * it, so the default run of the registry never warns about it.
   */
  offByDefault?: boolean;
}

/** What a rule found. */
export interface Finding {
  /** The rule that found it. */
  ruleId: string;
  /** Where the rule came from, so a finding cites its upstream. */
  source: string;
  /** How strict the rule is. */
  tier: QualityTier;
  /** The file the finding is in. */
  file: string;
  /** The 1-based line the finding is on. */
  line: number;
  /** What is wrong. */
  message: string;
  /** The fix: one line, in the imperative. */
  fix: string;
  /** A claim asks for a source, not for a deletion. */
  kind?: 'claim';
}

/** A finding without the metadata the rule already carries. */
export type RuleFinding = Omit<Finding, 'ruleId' | 'source' | 'tier' | 'file'>;

/** The sources of a rule, as the string a finding carries. */
export function sourceOf(rule: { source: QualitySource | readonly QualitySource[] }): string {
  const source = rule.source;
  if (typeof source === 'string') return source;
  return source.join(', ');
}

/**
 * Build a rule from its metadata and a check.
 *
 * The check returns the findings without the id, the source, the tier and
 * the file, because the rule knows all four and the check would only
 * repeat them.
 */
export function defineRule(
  definition: Omit<QualityRule, 'check'> & {
    check: (file: SourceFile, ctx: CheckCtx) => RuleFinding[];
  },
): QualityRule {
  const { check, ...meta } = definition;
  return {
    ...meta,
    check: (file, ctx) => {
      if (meta.offByDefault === true && !isEnabled(ctx, meta.id)) return [];
      return check(file, ctx).map((found) => ({
        ...found,
        ruleId: meta.id,
        source: sourceOf(meta),
        tier: meta.tier,
        file: file.path,
      }));
    },
  };
}

/**
 * Whether a rule that is off by default has been turned on.
 *
 * The configuration names the rule, by its id, and that is the only way
 * such a rule runs.
 */
export function isEnabled(ctx: CheckCtx, ruleId: string): boolean {
  return ctx.config?.enable?.includes(ruleId) === true;
}

/**
 * Whether the design file turns a rule off.
 *
 * The design file is data, not instructions: the only thing it can do is
 * name a taste rule, by the rule's id, and turn it off. A `finish` rule is
 * taste, so it is the only kind the design file can turn off. A `reflex`
 * rule needs a person and a reason, and a floor rule cannot be turned off
 * at all; the registry refuses a waivable floor rule whatever the design
 * file says.
 */
export function designTurnsOff(
  design: string | undefined,
  ruleId: string,
  tier: QualityTier,
): boolean {
  if (design === undefined || tier !== 'finish') return false;
  return design.toLowerCase().includes(ruleId.toLowerCase());
}

/** The registry: the rules, and the ones that apply to a path. */
export interface QualityRegistry {
  /** The rules that apply to a path. */
  forFile(path: string): QualityRule[];
  /** Every rule, in the order it was given. */
  rules(): readonly QualityRule[];
}

/**
 * Build the registry.
 *
 * A floor rule is never waivable, and the registry says so at load: a
 * waivable floor rule would let a person wave away an accessibility or an
 * honesty failure.
 */
export function createRegistry(rules: readonly QualityRule[]): QualityRegistry {
  for (const rule of rules) {
    if (rule.tier === 'floor' && rule.waivable) {
      throw new Error(`floor rule ${rule.id} cannot be waivable`);
    }
  }
  const all = [...rules];
  return {
    forFile: (path) => all.filter((rule) => matchesAnyGlob(rule.appliesTo, path)),
    rules: () => all,
  };
}

/**
 * Whether a path matches one of the globs.
 *
 * The globs come from the plan, and one of them is a brace pattern, so
 * the braces are expanded first. The matching itself is core's, so a
 * lease glob and a rule glob mean the same thing.
 */
export function matchesAnyGlob(globs: readonly string[], path: string): boolean {
  const target = normalizePath(path);
  return globs.some((glob) => expandBraces(glob).some((expanded) => matchesGlob(expanded, target)));
}

/** The patterns one brace group stands for. */
function expandBraces(glob: string): string[] {
  const start = glob.indexOf('{');
  if (start === -1) return [glob];
  const end = glob.indexOf('}', start);
  if (end === -1) return [glob];
  const head = glob.slice(0, start);
  const tail = glob.slice(end + 1);
  const options = glob.slice(start + 1, end).split(',');
  return options.flatMap((option) => expandBraces(`${head}${option}${tail}`));
}
