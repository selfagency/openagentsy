import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBreakerRegistry, createCircuitBreaker } from './circuit-breaker.js';

describe('the circuit breaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after the failure threshold', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000 });
    expect(breaker.state()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.allowsRequest()).toBe(false);
  });

  it('half-opens after the cooldown', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000 });
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    vi.advanceTimersByTime(29_999);
    expect(breaker.state()).toBe('open');
    vi.advanceTimersByTime(1);
    expect(breaker.state()).toBe('half-open');
  });

  it('allows one probe while half-open', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000 });
    breaker.recordFailure();
    vi.advanceTimersByTime(30_000);
    expect(breaker.allowsRequest()).toBe(true);
    expect(breaker.allowsRequest()).toBe(false);
  });

  it('closes when the probe succeeds', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000 });
    breaker.recordFailure();
    vi.advanceTimersByTime(30_000);
    breaker.allowsRequest();
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.allowsRequest()).toBe(true);
  });

  it('re-opens when the probe fails', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000 });
    breaker.recordFailure();
    vi.advanceTimersByTime(30_000);
    breaker.allowsRequest();
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.allowsRequest()).toBe(false);
  });

  it('counts the failures from zero again after a close', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 30_000 });
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
  });

  it('reports the time left on the cooldown', () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000 });
    breaker.recordFailure();
    expect(breaker.cooldownRemainingMs()).toBe(30_000);
    vi.advanceTimersByTime(10_000);
    expect(breaker.cooldownRemainingMs()).toBe(20_000);
  });

  it('lists the open backends', () => {
    const registry = createBreakerRegistry({ failureThreshold: 1, cooldownMs: 30_000 });
    registry.breakerFor('ollama:11434').recordFailure();
    expect(registry.getOpenBackends()).toEqual(['ollama:11434']);
    expect(registry.isOpen('ollama:11434')).toBe(true);
  });

  it('takes a backend off the open list once the cooldown has passed', () => {
    const registry = createBreakerRegistry({ failureThreshold: 1, cooldownMs: 30_000 });
    registry.breakerFor('ollama:11434').recordFailure();
    vi.advanceTimersByTime(30_000);
    expect(registry.getOpenBackends()).toEqual([]);
    expect(registry.isOpen('ollama:11434')).toBe(false);
  });

  it('gives every backend its own breaker', () => {
    const registry = createBreakerRegistry({ failureThreshold: 1 });
    registry.breakerFor('a').recordFailure();
    expect(registry.isOpen('a')).toBe(true);
    expect(registry.isOpen('b')).toBe(false);
  });
});
