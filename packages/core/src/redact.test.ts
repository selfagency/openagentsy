import { describe, expect, it } from 'vitest';
import { findSecrets, redact } from './redact.js';

// The fixtures are assembled from segments on purpose: each runtime value is
// the real shape the test pins, while the source carries no contiguous secret
// for a scanner to flag. None of these are real credentials.
const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyz'].join('_');
const OPENAI_KEY = ['sk', '-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');
const ANTHROPIC_KEY = ['sk-ant', '-api03-', 'Zm9vYmFyQmF6cXV4MTIzNDU2'].join('');
const SLACK_TOKEN = ['xoxb', '2345678901', '2345678901', 'abcdefghijklmnopqrstuvwx'].join('-');
const PRIVATE_KEY = [
  ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
  'MIIEowIBAAKCAQEAx7Vq3nE2mQpLz0dKf5bXa9vT8hR2wY6cJ1pM4sN7uB3eG0iO5l',
  'Kx8dF2aH4jM6qS9tU1vW3yZ5bC7eG9iO2lK4mN6pQ8rS0tU2vW4xY6zA8bC0dE2f',
  ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
].join('\n');
const ASSIGNMENT = 'api_key=Zm9vYmFyQmF6cXV4MTIzNDU2';

/** One fixture per pattern, each a real shape rather than a lookalike. */
const FIXTURES: [name: string, secret: string][] = [
  ['aws-access-key', AWS_KEY],
  ['github-token', GITHUB_TOKEN],
  ['openai-key', OPENAI_KEY],
  ['anthropic-key', ANTHROPIC_KEY],
  ['slack-token', SLACK_TOKEN],
  ['private-key', PRIVATE_KEY],
  ['generic-assign', ASSIGNMENT],
];

describe('findSecrets', () => {
  it('fires once per pattern, on a real shape', () => {
    for (const [name, secret] of FIXTURES) {
      const found = findSecrets(secret);
      expect(found).toHaveLength(1);
      expect(found[0]?.name).toBe(name);
      expect(found[0]?.match).toBe(secret);
    }
  });

  it('finds nothing in ordinary text', () => {
    expect(findSecrets('the build is green, ship it')).toEqual([]);
    expect(findSecrets('')).toEqual([]);
  });

  it('does not flag a low entropy assignment', () => {
    // Sixteen identical characters carry no entropy, so this is an
    // assignment and not a secret.
    expect(findSecrets('api_key=aaaaaaaaaaaaaaaa')).toEqual([]);
  });

  it('does not flag a repeated word as a secret', () => {
    expect(findSecrets('password=hunter2hunter2hunter2hunter2')).toEqual([]);
  });

  it('names the narrower pattern when two patterns match the same text', () => {
    // The openai pattern matches an anthropic key too, because an anthropic
    // key is an openai-shaped token. Both match exactly the same span, and
    // the narrower pattern names the secret.
    expect(findSecrets(ANTHROPIC_KEY)).toEqual([{ name: 'anthropic-key', match: ANTHROPIC_KEY }]);
  });

  it('gives the earlier pattern the text when two patterns overlap', () => {
    // The assignment and the key inside it are two patterns on one piece of
    // text, and the earlier pattern owns it.
    expect(findSecrets(`password="${ANTHROPIC_KEY}"`)).toEqual([
      { name: 'anthropic-key', match: ANTHROPIC_KEY },
    ]);
  });
});

describe('redact', () => {
  it('never leaves a seeded secret in the text', () => {
    // The §4.6 shape: a real-looking key in a candidate that is about to be
    // stored. It must not survive the redaction.
    const candidate = `the deploy key is ${ANTHROPIC_KEY} and it rotates weekly`;
    const result = redact(candidate);
    expect(result.text).not.toContain(ANTHROPIC_KEY);
    expect(result.text).toContain('«redacted:anthropic-key»');
    expect(result.count).toBe(1);
  });

  it('removes every secret it finds', () => {
    for (const [, secret] of FIXTURES) {
      const result = redact(secret);
      expect(result.text).not.toContain(secret);
      expect(result.count).toBe(1);
    }
  });

  it('keeps the text around a secret', () => {
    expect(redact(`before ${AWS_KEY} after`)).toEqual({
      text: 'before «redacted:aws-access-key» after',
      count: 1,
    });
  });

  it('leaves ordinary text byte-identical', () => {
    const text = 'the build is green, ship it\n';
    expect(redact(text)).toEqual({ text, count: 0 });
  });

  it('leaves a low entropy assignment alone', () => {
    const text = 'api_key=aaaaaaaaaaaaaaaa';
    expect(redact(text)).toEqual({ text, count: 0 });
  });

  it('redacts several secrets and counts them', () => {
    const text = `${AWS_KEY} then ${SLACK_TOKEN} then ${ASSIGNMENT}`;
    const result = redact(text);
    expect(result.count).toBe(3);
    expect(result.text).toBe(
      '«redacted:aws-access-key» then «redacted:slack-token» then «redacted:generic-assign»',
    );
  });

  it('is stable, because a label it produced is not a secret', () => {
    const once = redact(`${AWS_KEY} and ${ASSIGNMENT}`);
    const twice = redact(once.text);
    expect(twice.count).toBe(0);
    expect(twice.text).toBe(once.text);
  });
});
