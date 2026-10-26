/**
 * How the router may pick a backend.
 *
 * 'preferred' takes the local one and falls through to the alternatives.
 * 'required' takes the local one or nothing at all - the fail-closed mode
 * for a workspace that may not send a prompt off the machine. 'disabled'
 * turns offloading off.
 */
export type ReplicaMode = 'preferred' | 'required' | 'disabled';

/** One backend the router could pick, with the flags that say whether it can. */
export interface ReplicaCandidate {
  /** What names the backend. */
  id: string;
  /** The backend runs on this machine. */
  local: boolean;
  /** The backend answered its last health probe. */
  healthy: boolean;
  /** The circuit breaker of the backend is open. */
  circuitOpen: boolean;
}

/**
 * Pick the backend to use, or nothing. Nothing means the caller falls back:
 * in 'required' mode that is on purpose, because a prompt that may not leave
 * the machine does not leave it.
 */
export function selectReplica(
  candidates: readonly ReplicaCandidate[],
  mode: ReplicaMode,
): ReplicaCandidate | undefined {
  if (mode === 'disabled') return undefined;

  const usable = candidates.filter((candidate) => candidate.healthy && !candidate.circuitOpen);

  if (mode === 'required') return usable.find((candidate) => candidate.local);

  return (
    usable.find((candidate) => candidate.local) ?? usable.find((candidate) => !candidate.local)
  );
}
