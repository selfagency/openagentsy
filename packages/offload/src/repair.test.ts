import { describe, expect, it } from 'vitest';
import { repairJson } from './repair.js';

describe('the JSON repair', () => {
  it('completes a truncated answer', () => {
    expect(repairJson('{"title": "Hello wor')).toBe('{"title": "Hello wor"}');
  });

  it('drops a trailing comma', () => {
    expect(repairJson('{"title": "Hello",}')).toBe('{"title": "Hello"}');
  });

  it('drops a trailing comma in an array', () => {
    expect(repairJson('{"replies": ["a", "b",],}')).toBe('{"replies": ["a", "b"]}');
  });

  it('escapes a raw newline inside a string', () => {
    expect(repairJson('{"title": "a\nb"}')).toBe('{"title": "a\\nb"}');
  });

  it('escapes a raw tab inside a string', () => {
    expect(repairJson('{"title": "a\tb"}')).toBe('{"title": "a\\tb"}');
  });

  it('keeps an answer that is already valid', () => {
    expect(repairJson('{"title": "Hello"}')).toBe('{"title": "Hello"}');
  });

  it('keeps an escaped quote inside a string', () => {
    expect(repairJson('{"title": "say \\"hi\\""}')).toBe('{"title": "say \\"hi\\""}');
  });

  it('strips a code fence', () => {
    expect(repairJson('```json\n{"title": "Hello"}\n```')).toBe('{"title": "Hello"}');
  });

  it('leaves text that is not JSON alone', () => {
    expect(repairJson('not json at all')).toBe('not json at all');
  });

  it('drops a closing bracket that closes nothing', () => {
    expect(repairJson('{"title": "Hello"}}')).toBe('{"title": "Hello"}');
  });

  it('drops a dangling backslash when the answer was cut off', () => {
    expect(repairJson('{"title":"abc\\')).toBe('{"title":"abc"}');
  });

  it('drops a half-written unicode escape when the answer was cut off', () => {
    expect(repairJson('{"title":"abc\\u12')).toBe('{"title":"abc"}');
  });

  it('keeps a complete unicode escape', () => {
    expect(repairJson('{"title":"\\u00e9"}')).toBe('{"title":"\\u00e9"}');
  });
});
