/**
 * The three states of a breaker. 'closed' lets every request through,
 * 'open' lets none through, and 'half-open' lets exactly one through: the
 * probe that decides whether the backend is back.
 */
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** How many failures open the breaker. The default is 3. */
  failureThreshold?: number;
  /** How long an open breaker waits before it probes again. The default is 30 seconds. */
  cooldownMs?: number;
}

export interface CircuitBreaker {
  /** The state as of now. An open breaker past its cooldown reads half-open. */
  state(): BreakerState;
  /** Whether a request may go out. Half-open allows one probe at a time. */
  allowsRequest(): boolean;
  /** The backend answered. */
  recordSuccess(): void;
  /** The backend failed. */
  recordFailure(): void;
  /** How long the open breaker still waits. Zero when it may probe now. */
  cooldownRemainingMs(): number;
}

export interface BreakerRegistry {
  /** The breaker of one backend. The key names the backend. */
  breakerFor(key: string): CircuitBreaker;
  /** The backends that are open right now. */
  getOpenBackends(): string[];
  /** Whether one backend is open right now. */
  isOpen(key: string): boolean;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * A breaker for one backend. It counts failures, opens when there are too
 * many, waits out the cooldown, probes once, and closes when the probe works.
 */
export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  let state: BreakerState = 'closed';
  let failures = 0;
  let openedAt = 0;
  let probeInFlight = false;

  // The cooldown passing is what turns an open breaker into a half-open one,
  // and it happens when the breaker is looked at, not on a timer.
  const currentState = (): BreakerState => {
    if (state === 'open' && Date.now() - openedAt >= cooldownMs) {
      state = 'half-open';
      probeInFlight = false;
    }
    return state;
  };

  return {
    state: currentState,
    allowsRequest: () => {
      const now = currentState();
      if (now === 'closed') return true;
      if (now !== 'half-open') return false;
      if (probeInFlight) return false;
      probeInFlight = true;
      return true;
    },
    recordSuccess: () => {
      state = 'closed';
      failures = 0;
      openedAt = 0;
      probeInFlight = false;
    },
    recordFailure: () => {
      if (currentState() === 'half-open') {
        state = 'open';
        openedAt = Date.now();
        failures = 0;
        probeInFlight = false;
        return;
      }
      failures += 1;
      if (failures < failureThreshold) return;
      state = 'open';
      openedAt = Date.now();
      failures = 0;
      probeInFlight = false;
    },
    cooldownRemainingMs: () => {
      if (state !== 'open') return 0;
      return Math.max(0, cooldownMs - (Date.now() - openedAt));
    },
  };
}

/**
 * The breakers of every backend, keyed by backend. The router asks this
 * registry which backends are open before it picks one.
 */
export function createBreakerRegistry(options: CircuitBreakerOptions = {}): BreakerRegistry {
  const breakers = new Map<string, CircuitBreaker>();

  return {
    breakerFor: (key) => {
      const existing = breakers.get(key);
      if (existing) return existing;
      const created = createCircuitBreaker(options);
      breakers.set(key, created);
      return created;
    },
    getOpenBackends: () =>
      [...breakers.entries()]
        .filter(([, breaker]) => breaker.state() === 'open')
        .map(([key]) => key),
    isOpen: (key) => breakers.get(key)?.state() === 'open',
  };
}
