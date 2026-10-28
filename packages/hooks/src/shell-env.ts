/**
 * The environment every agent shell sees.
 *
 * The shell env hook tightens only: it removes the switches that skip the
 * hooks and the keys that belong to the board, and it marks the shell as
 * an agent's. It never adds a credential, because a credential in a shell
 * is a credential in every log the shell writes.
 */

/** The variables that are removed. */
export const STRIPPED_ENV_VARS = [
  'HUSKY',
  'HUSKY_SKIP_HOOKS',
  'SKIP_SIMPLE_GIT_HOOKS',
  'TOGETHER_API_KEY',
  'TYPESAFE_API_KEY',
] as const;

/**
 * Apply the policy to a shell environment.
 *
 * The environment is changed in place, because that is the shape the host
 * hands over: the shell env hook fills an object and the shell reads it, and
 * the V2 shell domain hands the plugin the same object before the child is
 * spawned.
 *
 * The values are optional, because the V2 event types the environment of a
 * shell that way. A key that is absent is a key that is not there.
 */
export function applyShellEnvPolicy(env: Record<string, string | undefined>): void {
  for (const key of STRIPPED_ENV_VARS) delete env[key];
  env.TURBO_TELEMETRY_DISABLED = '1';
  env.OPENAGENTSY_AGENT = '1';
}
