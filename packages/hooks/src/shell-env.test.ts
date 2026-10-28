import { describe, expect, it } from 'vitest';
import { applyShellEnvPolicy } from './shell-env.js';

describe('applyShellEnvPolicy', () => {
  it('takes the skip switches and the board keys out', () => {
    const env: Record<string, string> = {
      HUSKY: '0',
      HUSKY_SKIP_HOOKS: '1',
      SKIP_SIMPLE_GIT_HOOKS: '1',
      TOGETHER_API_KEY: 'a-key',
      TYPESAFE_API_KEY: 'a-key',
      PATH: '/usr/bin',
    };
    applyShellEnvPolicy(env);
    expect(env.HUSKY).toBeUndefined();
    expect(env.HUSKY_SKIP_HOOKS).toBeUndefined();
    expect(env.SKIP_SIMPLE_GIT_HOOKS).toBeUndefined();
    expect(env.TOGETHER_API_KEY).toBeUndefined();
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('turns the telemetry off and marks the shell as an agent', () => {
    const env: Record<string, string> = {};
    applyShellEnvPolicy(env);
    expect(env.TURBO_TELEMETRY_DISABLED).toBe('1');
    expect(env.OPENAGENTSY_AGENT).toBe('1');
  });

  it('never adds anything else', () => {
    const env: Record<string, string> = {};
    applyShellEnvPolicy(env);
    expect(Object.keys(env).sort()).toEqual(['OPENAGENTSY_AGENT', 'TURBO_TELEMETRY_DISABLED']);
  });

  it('takes a key out of an environment that holds an absent value', () => {
    // The V2 event types the environment of a shell that way: a value may be
    // absent. The policy is the same either way.
    const env: Record<string, string | undefined> = {
      TYPESAFE_API_KEY: 'a-key',
      PATH: undefined,
    };
    applyShellEnvPolicy(env);
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
    expect(env.PATH).toBeUndefined();
    expect(env.OPENAGENTSY_AGENT).toBe('1');
  });
});
