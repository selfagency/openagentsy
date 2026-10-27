import { describe, expect, it } from 'vitest';
import { type ApprovalEvent, applyApproval, commandApproval, SHELL_ACTION } from './v2-approval.js';

describe('the approval of a command on the v2 path', () => {
  it('asks about the command the project named', () => {
    // The V1 path wrote the command into the permission map and OpenCode
    // asked the person. The V2 path has no map to write, so the hook asks.
    const event: ApprovalEvent = {
      action: SHELL_ACTION,
      resources: ['git push --force origin main'],
      effect: 'allow',
    };

    const asked = applyApproval(event, ['git push']);

    expect(asked).toBe(true);
    expect(event.effect).toBe('ask');
    expect(event.message).toContain('git push');
  });

  it('asks about the command and everything after it', () => {
    // The pattern is the command and a wildcard, so `git push` asks about
    // `git push --force` as well.
    expect(commandApproval('git push --force', ['git push'])).toBe('git push');
    expect(commandApproval('git push', ['git push'])).toBe('git push');
  });

  it('leaves a command nobody asked about alone', () => {
    const event: ApprovalEvent = {
      action: SHELL_ACTION,
      resources: ['echo hello'],
      effect: 'allow',
    };

    const asked = applyApproval(event, ['git push']);

    expect(asked).toBe(false);
    expect(event.effect).toBe('allow');
  });

  it('does not match a command that only holds the word', () => {
    // `echo git push` is not `git push`, and a person who approved the one
    // did not approve the other.
    expect(commandApproval('echo git push', ['git push'])).toBeUndefined();
  });

  it('does not loosen a decision the host already made', () => {
    // The host denied it. A plugin may only tighten a decision, and `ask` is
    // looser than `deny`.
    const event: ApprovalEvent = {
      action: SHELL_ACTION,
      resources: ['git push'],
      effect: 'deny',
    };

    const asked = applyApproval(event, ['git push']);

    expect(asked).toBe(false);
    expect(event.effect).toBe('deny');
  });

  it('does not touch an action that is not the shell', () => {
    // A write is the lease rule's business, and the approval list is about
    // commands.
    const event: ApprovalEvent = {
      action: 'edit',
      resources: ['src/index.ts'],
      effect: 'allow',
    };

    const asked = applyApproval(event, ['git push']);

    expect(asked).toBe(false);
    expect(event.effect).toBe('allow');
  });

  it('ignores an empty entry', () => {
    // A blank line in the list is not a command, and a blank prefix would
    // match every command.
    expect(commandApproval('echo hello', ['  '])).toBeUndefined();
  });
});
