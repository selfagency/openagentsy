import { z } from 'zod';

/**
 * The eval artifacts: the executable proof that a lesson is real.
 *
 * An artifact is a list of scenarios. A baseline scenario says what the
 * behaviour is today, and a candidate scenario says what it should be. The
 * runner executes them and writes a result that holds the verdicts and never
 * the output, so a result can be kept without keeping what the run printed.
 */

/** The longest a scenario may run, in milliseconds. */
export const MAX_TIMEOUT_MS = 300_000;

/** The timeout a scenario gets when it names none. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The most scenarios an artifact may hold. */
export const MAX_SCENARIOS = 20;

/**
 * What a scenario asserts about the run.
 *
 * Every field is optional, and a field that is absent is not asserted: a
 * scenario that only names an exit code does not care what was printed.
 */
export const EvalExpectation = z.object({
  exit_code: z.number().int().optional(),
  stdout_includes: z.array(z.string()).optional(),
  stdout_excludes: z.array(z.string()).optional(),
  stderr_includes: z.array(z.string()).optional(),
  stderr_excludes: z.array(z.string()).optional(),
});

/**
 * One scenario: a command, a place to run it, and what it must show.
 *
 * The command is an argv, never a shell string. The schema says so by
 * holding an array, and the runner says it again before it spawns, because a
 * shell string is the one shape that turns a proof into an injection.
 */
export const EvalScenario = z.object({
  id: z.string().min(1),
  phase: z.enum(['baseline', 'candidate']),
  cwd: z.string().min(1),
  command: z.array(z.string()).min(1),
  timeout_ms: z.number().int().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  expect: EvalExpectation,
});

/**
 * The artifact.
 *
 * It needs at least one candidate scenario, because an artifact that only
 * shows the current behaviour proves nothing, and the scenario ids have to be
 * unique, because a result names its scenarios by id.
 */
export const EvalArtifact = z.object({
  schema_version: z.literal('1'),
  lesson_id: z.string().min(1),
  name: z.string().min(1),
  scenarios: z
    .array(EvalScenario)
    .min(1)
    .max(MAX_SCENARIOS)
    .refine((scenarios) => scenarios.some((scenario) => scenario.phase === 'candidate'), {
      message: 'needs a candidate scenario',
    })
    .refine(
      (scenarios) => new Set(scenarios.map((scenario) => scenario.id)).size === scenarios.length,
      { message: 'scenario ids must be unique' },
    ),
});

export type EvalArtifact = z.infer<typeof EvalArtifact>;
export type EvalScenario = z.infer<typeof EvalScenario>;
export type EvalExpectation = z.infer<typeof EvalExpectation>;

/** The verdict of every assertion a scenario made, by assertion name. */
export type EvalAssertions = Record<string, boolean>;

/**
 * What one scenario did.
 *
 * The argv is not here, only its hash: the result says which command ran
 * without carrying the command, and the output is not here at all.
 */
export interface EvalScenarioResult {
  id: string;
  phase: 'baseline' | 'candidate';
  /** The hash of the argv. */
  command_sha256: string;
  /** The exit code, or null when the process was killed at the timeout. */
  exit_code: number | null;
  /** Whether the process was killed at the timeout. */
  timed_out: boolean;
  /** How long the scenario ran, in milliseconds. */
  duration_ms: number;
  /** The verdict of every assertion the expectation named. */
  assertions: EvalAssertions;
  /** Whether every assertion held. */
  passed: boolean;
}

/**
 * What the runner produced.
 *
 * The result is the proof: it says what passed, how long it took, which
 * artifact it came from and which commands ran. It never says what any of
 * them printed.
 */
export interface EvalResult {
  schema_version: '1';
  lesson_id: string;
  /** The hash of the artifact the run came from. */
  artifact_sha256: string;
  started_at: string;
  finished_at: string;
  /** Whether every scenario passed. */
  passed: boolean;
  /**
   * How many times the proof ran.
   *
   * An artifact run is one. A proof that points at an evals/ suite needs
   * three: a suite that passes once has not shown that it always passes.
   */
  runs: number;
  scenarios: EvalScenarioResult[];
}

/**
 * The error the proof raises.
 *
 * It carries a hint, like every other error in this repository: the message
 * says what happened, the hint says what to do next.
 */
export class ProofError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'ProofError';
    this.hint = hint;
  }
}
