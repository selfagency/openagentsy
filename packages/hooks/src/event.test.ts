import { describe, expect, it } from 'vitest';
import { readPreToolCall } from './event.js';

describe('readPreToolCall', () => {
  it('keeps the files the host normalised', () => {
    const event = readPreToolCall({
      toolName: 'write',
      args: { filePath: '/repo/src/a.ts' },
      files: [{ path: '/repo/src/a.ts', fromPath: '/repo/src/b.ts' }],
    });
    expect(event?.files).toEqual([{ path: '/repo/src/a.ts', fromPath: '/repo/src/b.ts' }]);
  });

  it('reads the command out of the raw arguments', () => {
    const event = readPreToolCall({ toolName: 'bash', args: { command: 'ls -la' }, files: [] });
    expect(event?.command).toBe('ls -la');
  });

  it('reads the file out of the raw arguments', () => {
    const event = readPreToolCall({
      toolName: 'write',
      args: { filePath: '/repo/src/a.ts' },
      files: [],
    });
    expect(event?.files).toEqual([{ path: '/repo/src/a.ts' }]);
  });

  it('prefers the command the host normalised', () => {
    const event = readPreToolCall({
      toolName: 'bash',
      command: 'ls',
      args: { command: 'rm -rf /' },
      files: [],
    });
    expect(event?.command).toBe('ls');
  });

  it('carries the call id and the role', () => {
    const event = readPreToolCall({
      toolName: 'bash',
      args: {},
      files: [],
      callID: 'call-1',
      role: 'builder',
    });
    expect(event?.callID).toBe('call-1');
    expect(event?.role).toBe('builder');
  });

  it('says nothing about an event that is not a tool call', () => {
    expect(readPreToolCall({})).toBeUndefined();
    expect(readPreToolCall('not an event')).toBeUndefined();
  });
});
