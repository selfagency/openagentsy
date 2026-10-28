import { describe, expect, it } from 'vitest';
import { redactForStorage } from './secrets.js';

// The fixture is assembled from segments on purpose: the value is the real
// shape the helper pins, and the source carries no contiguous secret for a
// scanner to flag. It is not a credential.
const OPENAI_KEY = ['sk', '-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');

describe('redactForStorage', () => {
  it('redacts a secret and reports the count', () => {
    const result = redactForStorage(`the key is ${OPENAI_KEY}`);
    expect(result.count).toBe(1);
    expect(result.text).not.toContain('ABCDEFGH');
    expect(result.text).toContain('«redacted:openai-key»');
  });

  it('leaves clean text alone', () => {
    const result = redactForStorage('the build is green');
    expect(result.count).toBe(0);
    expect(result.text).toBe('the build is green');
  });
});
