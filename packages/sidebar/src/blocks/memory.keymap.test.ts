import type { DecideOutcome } from '@openagentsy/memory';
import { describe, expect, it } from 'vitest';
import type { MemoryView } from '../readers.js';
import { EMPTY_MEMORY, MEMORY } from '../testing/fixtures.js';
import { fakeHost, type Host } from '../testing/harness.js';
import { APPROVE_COMMAND, memoryInboxKeymap, REJECT_COMMAND } from './memory.keymap.js';

/**
 * The keys of the memory inbox.
 *
 * The layer is registered with the host, and the host keeps the commands
 * and the bindings it was given. The test reads the layer back, so a key
 * that was renamed or unbound is seen here.
 */

/** The outcome of a decision that went through. */
const OK: DecideOutcome = {
  ok: true,
  decision: 'approve',
  recordId: 12,
  state: 'promoted',
  redactions: 0,
};

/** The outcome of a decision that did not go through. */
const FAILED: DecideOutcome = {
  ok: false,
  reason: 'already-decided',
  detail: 'the record 12 was already decided',
  recordId: 12,
  redactions: 0,
};

/** The decisions a keymap made. */
interface Decision {
  readonly id: number;
  readonly decision: string;
}

/** A host with the keymap registered on it. */
function hostWithKeys(
  view: () => MemoryView,
  decided: Decision[],
  outcome: DecideOutcome = OK,
): Host {
  const host = fakeHost();
  memoryInboxKeymap({
    context: host.context,
    view,
    decide: async (id, decision) => {
      decided.push({ id, decision });
      return outcome;
    },
  });
  return host;
}

describe('the memory inbox keys', () => {
  it('registers a layer with the approve and the reject key', () => {
    const host = hostWithKeys(() => MEMORY, []);

    expect(host.layers).toHaveLength(1);
    const layer = host.layers.at(0);
    expect(layer?.commands?.map((command) => command.id)).toEqual([
      APPROVE_COMMAND,
      REJECT_COMMAND,
    ]);
    expect(layer?.commands?.at(0)?.bind).toBe('a');
    expect(layer?.commands?.at(1)?.bind).toBe('r');
  });

  it('leaves the mode out, so the host keeps the layer off the prompt', () => {
    const host = hostWithKeys(() => MEMORY, []);

    const layer = host.layers.at(0);
    expect(layer?.mode).toBeUndefined();
    expect(layer?.mode).not.toBe('global');
  });

  it('is disabled while no candidate waits', () => {
    const empty = hostWithKeys(() => EMPTY_MEMORY, []);
    const full = hostWithKeys(() => MEMORY, []);

    const disabled = empty.layers.at(0)?.enabled;
    const enabled = full.layers.at(0)?.enabled;
    expect(typeof disabled === 'function' ? disabled() : disabled).toBe(false);
    expect(typeof enabled === 'function' ? enabled() : enabled).toBe(true);
  });

  it('approves the first candidate that waits', async () => {
    const decided: Decision[] = [];
    const host = hostWithKeys(() => MEMORY, decided);

    const approve = host.layers.at(0)?.commands?.find((command) => command.id === APPROVE_COMMAND);
    await approve?.run();

    expect(decided).toEqual([{ id: 12, decision: 'approve' }]);
  });

  it('rejects the first candidate that waits', async () => {
    const decided: Decision[] = [];
    const host = hostWithKeys(() => MEMORY, decided);

    const reject = host.layers.at(0)?.commands?.find((command) => command.id === REJECT_COMMAND);
    await reject?.run();

    expect(decided).toEqual([{ id: 12, decision: 'reject' }]);
  });

  it('does not swallow a decision that did not go through', async () => {
    const decided: Decision[] = [];
    const host = hostWithKeys(() => MEMORY, decided, FAILED);

    const approve = host.layers.at(0)?.commands?.find((command) => command.id === APPROVE_COMMAND);
    await expect(Promise.resolve(approve?.run())).rejects.toThrow('already decided');
  });

  it('decides on nothing when no candidate waits', async () => {
    const decided: Decision[] = [];
    const host = hostWithKeys(() => EMPTY_MEMORY, decided);

    const approve = host.layers.at(0)?.commands?.find((command) => command.id === APPROVE_COMMAND);
    await approve?.run();

    expect(decided).toEqual([]);
  });
});
