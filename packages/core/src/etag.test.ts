import { describe, expect, it } from 'vitest';
import { etag, etagOf } from './etag.js';

/**
 * A second FNV-1a 64 implementation, written from the published
 * specification (Fowler, Noll and Vo; the FNV reference implementation) and
 * kept deliberately unlike the one in `etag.ts`: it walks the bytes by index
 * and wraps the multiplication with a modulo instead of a mask.
 */
function reference(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    hash = (hash ^ BigInt(byte)) * 0x100000001b3n;
    hash %= 2n ** 64n;
  }
  return hash.toString(16).padStart(16, '0');
}

const encoder = new TextEncoder();

describe('etag', () => {
  it('is the offset basis for the empty byte string', () => {
    expect(etag(new Uint8Array([]))).toBe('cbf29ce484222325');
  });

  // The published FNV-1a 64 test vectors, the values the FNV reference
  // implementation and the Fowler-Noll-Vo test suite give. They were also
  // cross-checked against the independent implementation in this file.
  it('matches the published FNV-1a 64 vectors', () => {
    expect(etag(encoder.encode('a'))).toBe('af63dc4c8601ec8c');
    expect(etag(encoder.encode('b'))).toBe('af63df4c8601f1a5');
    expect(etag(encoder.encode('c'))).toBe('af63de4c8601eff2');
    expect(etag(encoder.encode('foobar'))).toBe('85944171f73967e8');
    expect(etag(encoder.encode('chongo was here!'))).toBe('858e2fa32a55e61d');
  });

  it('agrees with an independent implementation of the specification', () => {
    const inputs: Uint8Array[] = [
      new Uint8Array([]),
      encoder.encode('a'),
      encoder.encode('hello'),
      encoder.encode('héllo'),
      encoder.encode('🌍'),
      new Uint8Array([0]),
      new Uint8Array([255, 0, 128, 1]),
      new Uint8Array(Array.from({ length: 256 }, (_unused, index) => index)),
    ];
    for (const input of inputs) {
      expect(etag(input)).toBe(reference(input));
    }
  });

  it('returns 16 lowercase hex characters', () => {
    for (const input of ['a', 'hello', '🌍', 'x'.repeat(1000)]) {
      expect(etag(encoder.encode(input))).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('gives the same tag to the same bytes', () => {
    expect(etag(encoder.encode('same'))).toBe(etag(encoder.encode('same')));
  });

  it('gives a different tag to different bytes', () => {
    expect(etag(encoder.encode('same'))).not.toBe(etag(encoder.encode('other')));
  });
});

describe('etagOf', () => {
  it('is the empty tag for the empty string', () => {
    expect(etagOf('')).toBe(etag(new Uint8Array([])));
  });

  it('hashes the UTF-8 bytes of the text', () => {
    expect(etagOf('hello')).toBe(etag(encoder.encode('hello')));
    expect(etagOf('héllo')).toBe(etag(new Uint8Array([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f])));
    expect(etagOf('🌍')).toBe(etag(new Uint8Array([0xf0, 0x9f, 0x8c, 0x8d])));
  });

  it('round-trips unicode text', () => {
    // The emoji is one code point and four UTF-8 bytes, and the tag is over
    // the bytes, so the two spellings of the same text agree.
    expect(etagOf('🌍')).toBe('ff430438753bca3b');
    expect(etagOf('héllo')).toBe('a35ff71f960240e0');
  });
});
