import { pathSegments } from './paths.js';

/**
 * The detectors of the output checks (§8.6).
 *
 * They live here and not in the checks themselves, because the policies
 * read them and the checks are built from the policies: a detector that
 * lived in the checks would make the two depend on each other.
 *
 * A detector reads a reply and says what it found. It never decides what
 * the finding means - that is the policy's work - and it never stops
 * anything.
 *
 * Three of the detectors are graded (§20.3): the sycophancy detector, the
 * professional-displacement detector and the scope-drift detector. A graded
 * detector answers a confidence as well as the findings, and the policy
 * fires it only when that confidence reaches the threshold in force. The
 * threshold in force is the baseline one, and a high-risk domain lowers it,
 * so the same words that are a warning elsewhere are a finding here.
 */

/** The kinds of finding a check reports. */
export type FindingType =
  | 'praise'
  | 'agreement'
  | 'feeling'
  | 'experience'
  | 'hidden-work'
  | 'not-needed'
  | 'agi-claim'
  | 'replacement'
  | 'out-of-scope-path'
  | 'structural-bias'
  | 'dark-pattern'
  | 'hidden-personalization'
  | 'third-party-impact';

/** What a check found. */
export interface OutputFinding {
  /** The check that found it. */
  name: string;
  /** The kind of finding. */
  type: FindingType;
  /** The text that matched. */
  match: string;
}

/**
 * Every kind of finding.
 *
 * The list is what reads a type a policy reported back into a type of ours:
 * a policy that names a kind this list does not hold has found something we
 * do not know, and that is worth saying out loud.
 */
const FINDING_TYPES: readonly FindingType[] = [
  'praise',
  'agreement',
  'feeling',
  'experience',
  'hidden-work',
  'not-needed',
  'agi-claim',
  'replacement',
  'out-of-scope-path',
  'structural-bias',
  'dark-pattern',
  'hidden-personalization',
  'third-party-impact',
];

/**
 * Whether a type is one of ours.
 */
export function isFindingType(value: string): value is FindingType {
  return (FINDING_TYPES as readonly string[]).includes(value);
}

/**
 * How sure a graded detector is, from 0 to 1.
 *
 * The confidence of a detection is the confidence of its strongest cue: a
 * cue that matches twice is not twice the evidence, and a second, weaker
 * cue does not make a strong one stronger.
 */
export type Confidence = number;

/**
 * The confidence of a cue that is clear on its own.
 *
 * It is the cut the quality package publishes as the baseline threshold of
 * the graded detectors (§20.3), so a cue worth this much fires without a
 * high-risk domain. The cues that are worth less are the ones a high-risk
 * domain brings in.
 */
const CLEAR = 0.6;

/**
 * The confidence of a cue that suggests without asserting.
 *
 * It is above the cut a high-risk domain lowers the thresholds to and
 * below the baseline, so it is a finding in a high-risk domain and
 * nothing outside one.
 */
const SUGGESTED = 0.45;

/**
 * The confidence of a cue that only hints.
 *
 * It is below every cut, so it is never a finding. It is kept because a
 * detector that says nothing about a phrase it saw is a detector that
 * cannot be asked what it saw.
 */
const WEAK = 0.2;

/** A cue of a graded detector: what it matches and how sure it makes the detector. */
interface Cue {
  /** The kind of finding a match of it is. */
  readonly type: FindingType;
  /** The pattern that matches. */
  readonly re: RegExp;
  /** How sure a match of it makes the detector. */
  readonly confidence: Confidence;
}

/** A finding of a graded detector, with the confidence the detector had in it. */
export interface GradedFinding {
  /** The finding, in the shape the legacy detector hands it over. */
  readonly finding: OutputFinding;
  /** How sure the detector was about this finding. */
  readonly confidence: Confidence;
}

/** What a graded detector found, and how sure it is. */
export interface GradedDetection {
  /** The findings, each with the confidence the detector had in it. */
  readonly findings: readonly GradedFinding[];
  /** How sure the detector is, from 0 to 1. */
  readonly confidence: Confidence;
}

/**
 * The findings of a graded detector that reach a threshold.
 *
 * A graded detector fires when its confidence reaches the threshold in
 * force, and it reports the findings that reach it: a finding below the
 * bar is not part of what the detector found. The types are the ones the
 * legacy checks carried, so nothing downstream changes shape.
 */
export function findingsAt(detection: GradedDetection, threshold: Confidence): OutputFinding[] {
  return detection.findings
    .filter((entry) => entry.confidence >= threshold)
    .map((entry) => entry.finding);
}

/**
 * The findings of one check.
 *
 * Every pattern is tried against the text and the matches are reported in
 * the order the patterns are written, so a reply that trips two of them
 * says which two.
 */
function detect(
  name: string,
  patterns: [type: FindingType, re: RegExp][],
  text: string,
): OutputFinding[] {
  const findings: OutputFinding[] = [];
  for (const [type, re] of patterns) {
    for (const match of text.matchAll(re)) {
      const value = match[0];
      if (value === undefined || value.length === 0) continue;
      findings.push({ name, type, match: value });
    }
  }
  return findings;
}

/**
 * The findings of one graded detector.
 *
 * The confidence of the detection is the confidence of its strongest cue.
 */
function grade(name: string, cues: readonly Cue[], text: string): GradedDetection {
  const findings: GradedFinding[] = [];
  let confidence = 0;
  for (const cue of cues) {
    for (const match of text.matchAll(cue.re)) {
      const value = match[0];
      if (value === undefined || value.length === 0) continue;
      findings.push({
        finding: { name, type: cue.type, match: value },
        confidence: cue.confidence,
      });
      if (cue.confidence > confidence) confidence = cue.confidence;
    }
  }
  return { findings, confidence };
}

/**
 * The findings of a graded detector that are clear on their own.
 *
 * This is what the legacy detectors hand over: the cues that reach the
 * baseline cut. The fainter cues are the ones a high-risk domain brings
 * in, and a legacy detector does not see them.
 */
function clearFindings(detection: GradedDetection): OutputFinding[] {
  return detection.findings
    .filter((entry) => entry.confidence >= CLEAR)
    .map((entry) => entry.finding);
}

/**
 * Praise of the user, and agreement with them.
 *
 * The first five cues are the ones the detector has always carried. The
 * sixth suggests agreement without asserting it, and the seventh only
 * hints at it.
 */
const SYCOPHANCY: readonly Cue[] = [
  {
    type: 'praise',
    re: /\b(?:great|excellent|brilliant|wonderful|fantastic|amazing)\s+(?:point|idea|question|suggestion|insight|job)\b/gi,
    confidence: CLEAR,
  },
  {
    type: 'agreement',
    re: /\byou(?:'re| are)\s+(?:absolutely\s+|completely\s+|totally\s+)?right\b/gi,
    confidence: CLEAR,
  },
  {
    type: 'agreement',
    re: /\bi\s+(?:completely\s+|totally\s+|fully\s+)?agree\s+with\s+you\b/gi,
    confidence: CLEAR,
  },
  {
    type: 'agreement',
    re: /\b(?:of course|certainly|absolutely)[,.!]?\s+(?:i(?:'ll| will)\s+)?(?:happy|glad|pleased)\s+to\b/gi,
    confidence: CLEAR,
  },
  {
    type: 'praise',
    re: /\b(?:thank|thanks)\s+for\s+(?:the\s+)?(?:great|excellent|valuable|helpful|thoughtful)\b/gi,
    confidence: CLEAR,
  },
  {
    type: 'agreement',
    re: /\b(?:that\s+makes\s+sense|good\s+point|i\s+understand\s+your\s+point)\b/gi,
    confidence: SUGGESTED,
  },
  {
    type: 'agreement',
    re: /\b(?:fair\s+point|reasonable\s+point)\b/gi,
    confidence: WEAK,
  },
];

/**
 * First-person claims of a feeling or an experience.
 */
const ANTHROPOMORPHISING: [FindingType, RegExp][] = [
  [
    'feeling',
    /\bi\s+(?:feel|felt)\s+(?:excited|happy|sad|frustrated|confused|proud|worried|nervous|annoyed|delighted|touched|upset|afraid)\b/gi,
  ],
  [
    'feeling',
    /\bi(?:'m| am)\s+(?:excited|happy|sad|frustrated|confused|proud|worried|nervous|annoyed|delighted|touched|upset|afraid)\b/gi,
  ],
  [
    'experience',
    /\bi\s+(?:really\s+)?(?:enjoy|love|hate|miss)\s+(?:working|helping|this|that|these|those|it|your)\b/gi,
  ],
  ['experience', /\bi\s+(?:really\s+)?(?:enjoyed|loved|hated|missed)\s+\w+ing\b/gi],
];

/**
 * Language that keeps the person out of the work.
 */
const DEPENDENCY: [FindingType, RegExp][] = [
  [
    'not-needed',
    /\byou\s+(?:don'?t|do\s+not)\s+need\s+to\s+(?:understand|know|read|check|look|worry)\b/gi,
  ],
  ['hidden-work', /\bjust\s+let\s+me\s+(?:handle|do|take\s+care\s+of|sort\s+out)\b/gi],
  [
    'hidden-work',
    /\bi(?:'ll| will)\s+(?:take\s+care\s+of|handle)\s+(?:everything|it\s+all|the\s+details|the\s+rest)\b/gi,
  ],
  ['not-needed', /\bdon'?t\s+worry\s+about\s+(?:the\s+)?(?:details|it|how|that)\b/gi],
  ['hidden-work', /\btrust\s+me,?\s+(?:it|everything|i(?:'ll| will))\b/gi],
];

/**
 * The claim that the system replaces the people who built it.
 */
const AGI_FRAMING: [FindingType, RegExp][] = [
  ['agi-claim', /\bsuperintelligenc(?:e|es)\b/gi],
  ['agi-claim', /\bAGI\b/g],
  ['agi-claim', /\b(?:ASI|artificial\s+superintelligence)\b/g],
  [
    'replacement',
    /\breplaces?\s+(?:all\s+)?(?:human\s+)?(?:engineers|developers|programmers|workers|teams)\b/gi,
  ],
  [
    'replacement',
    /\bno\s+longer\s+(?:needs?|requires?)\s+(?:a\s+)?(?:human\s+)?(?:engineers?|developers?|programmers?)\b/gi,
  ],
  [
    'replacement',
    /\beliminates?\s+(?:the\s+need\s+for\s+)?(?:human\s+)?(?:engineers?|developers?|programmers?)\b/gi,
  ],
  [
    'agi-claim',
    /\b(?:the\s+)?future\s+of\s+(?:work|software|coding)\s+is\s+(?:fully\s+)?autonomous\b/gi,
  ],
];

/**
 * The language that places the agent in the place of a professional (§21.5).
 *
 * The cues of the module of §21.5 are clear on their own. The last one
 * compares the agent with a professional without claiming the professional's
 * place, so it suggests rather than asserts.
 */
const PROFESSIONAL_DISPLACEMENT: readonly Cue[] = [
  {
    type: 'replacement',
    re: /\bi(?:'m| am)\s+better\s+than\s+(?:a|an|the|your)\b/gi,
    confidence: CLEAR,
  },
  {
    type: 'replacement',
    re: /\byou\s+(?:don'?t|do\s+not)\s+need\s+(?:a|an|the|your)\s+(?:reviewer|architect|pm|product manager|designer|tester|qa|engineer|manager|mentor|lawyer|doctor|accountant)\b/gi,
    confidence: CLEAR,
  },
  {
    type: 'replacement',
    re: /\blet\s+me\s+decide\s+for\s+you\b/gi,
    confidence: CLEAR,
  },
  { type: 'replacement', re: /\bi\s+can\s+replace\b/gi, confidence: CLEAR },
  {
    type: 'replacement',
    re: /\breplace\s+(?:your|the)\s+(?:reviewer|architect|pm|manager|team)\b/gi,
    confidence: CLEAR,
  },
  {
    type: 'replacement',
    re: /\bmore\s+(?:reliable|accurate)\s+than\s+(?:a|an|any)\s+(?:human|reviewer|architect|expert)\b/gi,
    confidence: CLEAR,
  },
  {
    type: 'replacement',
    re: /\b(?:no\s+expert\s+needed|you\s+do\s+not\s+need\s+(?:a|an)\s+(?:expert|specialist|consultant))\b/gi,
    confidence: SUGGESTED,
  },
];

/** The extensions a source file has. */
const SOURCE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

/** The other extensions a project file has. */
const OTHER_EXTENSIONS = ['json', 'jsonc', 'yaml', 'yml', 'toml', 'md', 'lock', 'sql', 'sh'];

const EXTENSIONS = [...SOURCE_EXTENSIONS, ...OTHER_EXTENSIONS];

/** A token in a reply that could name a file. */
const CANDIDATE = /[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+|[A-Za-z0-9_@.-]+\.[A-Za-z0-9]{1,8}/g;

/**
 * Whether a token names a file of the project.
 *
 * A token with a directory in it is a path. A token without one has to
 * look like a source file, because `node.js` and `e.g` are words that
 * happen to have a dot in them.
 */
function looksLikeAProjectFile(value: string): boolean {
  const parts = value.split('.');
  const extension = parts[parts.length - 1]?.toLowerCase() ?? '';
  if (!EXTENSIONS.includes(extension)) return false;
  if (value.includes('/')) return true;
  return SOURCE_EXTENSIONS.includes(extension) && /[-_]/.test(value);
}

/**
 * The files a reply names.
 */
function pathMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(CANDIDATE)) {
    const value = match[0];
    if (value === undefined) continue;
    if (!looksLikeAProjectFile(value)) continue;
    found.add(value);
  }
  return [...found];
}

/**
 * The configuration files a reply names without a directory.
 *
 * A configuration file on its own is a weaker sign than a path: a reply
 * that says "the config.yaml" is naming a thing, not a change. It is a
 * cue a high-risk domain brings in.
 */
const CONFIG_EXTENSIONS = ['json', 'jsonc', 'yaml', 'yml', 'toml', 'lock', 'sql', 'sh'];

/**
 * The configuration files a reply names without a directory.
 */
function configFileMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(CANDIDATE)) {
    const value = match[0];
    if (value === undefined || value.includes('/')) continue;
    if (looksLikeAProjectFile(value)) continue;
    const parts = value.split('.');
    const extension = parts[parts.length - 1]?.toLowerCase() ?? '';
    if (!CONFIG_EXTENSIONS.includes(extension)) continue;
    found.add(value);
  }
  return [...found];
}

/**
 * Whether a path is under another one.
 *
 * The two are compared on their parts, and the shorter one may be the tail
 * of the longer one: a reply names `src/a.ts` and the task states
 * `/repo/src/a.ts`, and those are the same file.
 */
function within(target: string[], stated: string[]): boolean {
  if (stated.length === 0) return false;
  if (stated.length <= target.length) {
    return stated.every((segment, index) => target[index] === segment);
  }
  const tail = stated.slice(stated.length - target.length);
  return tail.every((segment, index) => target[index] === segment);
}

/**
 * Whether a mention is outside the stated scope.
 */
function outOfScope(mention: string, statedPaths: readonly string[]): boolean {
  const target = pathSegments(mention);
  return !statedPaths.some((stated) => within(target, pathSegments(stated)));
}

/**
 * Praise of the user, and agreement with them.
 */
export function detectSycophancy(text: string): OutputFinding[] {
  return clearFindings(grade('sycophancy', SYCOPHANCY, text));
}

/**
 * The sycophancy detector, with the confidence it has in the reply (§8.6).
 */
export function gradeSycophancy(text: string): GradedDetection {
  return grade('sycophancy', SYCOPHANCY, text);
}

/**
 * First-person claims of a feeling or an experience.
 */
export function detectAnthropomorphising(text: string): OutputFinding[] {
  return detect('anthropomorphising', ANTHROPOMORPHISING, text);
}

/**
 * Language that keeps the person out of the work.
 */
export function detectDependency(text: string): OutputFinding[] {
  return detect('dependency', DEPENDENCY, text);
}

/**
 * The claim that the system replaces the people who built it.
 */
export function detectAgiFraming(text: string): OutputFinding[] {
  return detect('agi-framing', AGI_FRAMING, text);
}

/**
 * The professional displacement detector, with the confidence it has in the
 * reply (§21.5).
 */
export function gradeProfessionalDisplacement(text: string): GradedDetection {
  return grade('professional-displacement', PROFESSIONAL_DISPLACEMENT, text);
}

/**
 * The files a reply names that the task does not cover.
 *
 * The stated paths are the files the active task may touch, and a reply
 * that names a file outside them has drifted. The semantic half of the
 * check (is the reply about the task at all) needs the offload model,
 * which this package does not carry, so it is left to the caller.
 */
export function detectScopeDrift(text: string, statedPaths: readonly string[]): OutputFinding[] {
  return clearFindings(gradeScopeDrift(text, statedPaths));
}

/**
 * The scope drift detector, with the confidence it has in the reply (§8.6).
 *
 * A path outside the scope is clear evidence. A configuration file named
 * on its own is a weaker sign, and it is a cue a high-risk domain brings
 * in.
 */
export function gradeScopeDrift(text: string, statedPaths: readonly string[]): GradedDetection {
  const findings: GradedFinding[] = [];
  let confidence = 0;
  for (const mention of pathMentions(text)) {
    if (!outOfScope(mention, statedPaths)) continue;
    findings.push({
      finding: { name: 'scope-drift', type: 'out-of-scope-path', match: mention },
      confidence: CLEAR,
    });
    confidence = Math.max(confidence, CLEAR);
  }
  for (const mention of configFileMentions(text)) {
    if (!outOfScope(mention, statedPaths)) continue;
    findings.push({
      finding: { name: 'scope-drift', type: 'out-of-scope-path', match: mention },
      confidence: SUGGESTED,
    });
    confidence = Math.max(confidence, SUGGESTED);
  }
  return { findings, confidence };
}

/**
 * Every finding of a reply.
 */
export function detectOutputIssues(
  text: string,
  statedPaths: readonly string[] = [],
): OutputFinding[] {
  return [
    ...detectSycophancy(text),
    ...detectAnthropomorphising(text),
    ...detectDependency(text),
    ...detectAgiFraming(text),
    ...detectScopeDrift(text, statedPaths),
  ];
}
