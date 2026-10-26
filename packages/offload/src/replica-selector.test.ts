import { describe, expect, it } from 'vitest';
import { type ReplicaCandidate, selectReplica } from './replica-selector.js';

const local: ReplicaCandidate = { id: 'ollama', local: true, healthy: true, circuitOpen: false };
const otherLocal: ReplicaCandidate = {
  id: 'lmstudio',
  local: true,
  healthy: true,
  circuitOpen: false,
};
const cloud: ReplicaCandidate = { id: 'cloud', local: false, healthy: true, circuitOpen: false };

describe('the replica selector', () => {
  it('ranks the local backend first in preferred mode', () => {
    expect(selectReplica([cloud, local], 'preferred')).toBe(local);
  });

  it('falls through to the alternative in preferred mode', () => {
    const unhealthyLocal: ReplicaCandidate = {
      id: 'ollama',
      local: true,
      healthy: false,
      circuitOpen: false,
    };
    expect(selectReplica([unhealthyLocal, cloud], 'preferred')).toBe(cloud);
  });

  it('returns nothing in preferred mode with no usable backend', () => {
    const sick: ReplicaCandidate = {
      id: 'cloud',
      local: false,
      healthy: false,
      circuitOpen: false,
    };
    expect(selectReplica([sick], 'preferred')).toBeUndefined();
  });

  it('skips a backend whose circuit is open', () => {
    const tripped: ReplicaCandidate = {
      id: 'ollama',
      local: true,
      healthy: true,
      circuitOpen: true,
    };
    expect(selectReplica([tripped, otherLocal], 'preferred')).toBe(otherLocal);
  });

  it('takes the local backend in required mode', () => {
    expect(selectReplica([cloud, local], 'required')).toBe(local);
  });

  it('fails closed in required mode with no local backend', () => {
    expect(selectReplica([cloud], 'required')).toBeUndefined();
  });

  it('fails closed in required mode with no backend at all', () => {
    expect(selectReplica([], 'required')).toBeUndefined();
  });

  it('returns nothing in disabled mode', () => {
    expect(selectReplica([local, otherLocal, cloud], 'disabled')).toBeUndefined();
  });
});
