import { describe, expect, it } from 'vitest';
import { replyPartsOf } from './opencode.js';

describe('replyPartsOf', () => {
  it('reads the text of the last assistant message', () => {
    const { text } = replyPartsOf([
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'the question' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'the answer' }] },
    ]);
    expect(text).toBe('the answer');
  });

  it('reads the tool calls of the last assistant message', () => {
    const { toolCalls } = replyPartsOf([
      {
        info: { role: 'assistant' },
        parts: [{ type: 'tool', tool: 'edit', state: { input: { filePath: 'src/app.ts' } } }],
      },
    ]);
    expect(toolCalls).toEqual([{ tool: 'edit', input: { filePath: 'src/app.ts' } }]);
  });

  it('takes the reply that came after a rate limit', () => {
    // The provider refused the turn, then the turn was asked again and the
    // agent answered. The reply is the answer, not the refusal.
    const { text } = replyPartsOf([
      {
        info: { role: 'assistant', error: { data: { statusCode: 429 } } },
        parts: [{ type: 'text', text: 'rate limited' }],
      },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'the real answer' }] },
    ]);
    expect(text).toBe('the real answer');
  });

  it('returns nothing for an empty session', () => {
    expect(replyPartsOf([])).toEqual({ text: '', toolCalls: [] });
  });

  it('skips the synthetic message a climb leaves behind', () => {
    // The model switch is a message of its own, and it carries no reply.
    // Taking the last message lost the reply, and the case looked like the
    // agent had said nothing.
    const { text } = replyPartsOf([
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'the answer' }] },
      {
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: 'effort ladder: model high',
            synthetic: true,
            ignored: true,
          },
        ],
      },
    ]);
    expect(text).toBe('the answer');
  });
});
