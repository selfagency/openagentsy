import { describe, expect, it } from 'vitest';
import { baseTool, baseToolName, toolVocabulary } from './base-tool.js';

/**
 * The pattern revision 1 used to strip a server prefix.
 *
 * It looked ahead for `oa_`, so it left every `board_*` name alone. The
 * test below pins that the old pattern would not have resolved the name.
 */
const OLD_PREFIX = /^[a-z0-9-]+_(?=oa_)/i;

describe('the base tool name', () => {
  it('resolves a board tool the old prefix pattern left alone', () => {
    const name = 'openagentsy-board_board_record';
    expect(OLD_PREFIX.test(name)).toBe(false);
    expect(baseToolName(name, toolVocabulary)).toBe('board_record');
  });

  it('keeps a tool that is already its base name', () => {
    expect(baseToolName('oa_task_list', toolVocabulary)).toBe('oa_task_list');
    expect(baseTool('oa_task_list')).toBe('oa_task_list');
  });

  it('returns an unknown tool as it is', () => {
    expect(baseToolName('a_tool_nobody_registers', toolVocabulary)).toBe('a_tool_nobody_registers');
  });

  it('takes the longest suffix the vocabulary knows', () => {
    expect(baseToolName('openagentsy-board_oa_task_list', toolVocabulary)).toBe('oa_task_list');
    expect(baseToolName('openagentsy-memory_oa_memory_decide', toolVocabulary)).toBe(
      'oa_memory_decide',
    );
    expect(baseToolName('openagentsy-board_board_lease_grant', toolVocabulary)).toBe(
      'board_lease_grant',
    );
  });

  it('knows the board, the task and the memory tools', () => {
    expect(toolVocabulary).toContain('board_record');
    expect(toolVocabulary).toContain('oa_task_list');
    expect(toolVocabulary).toContain('oa_memory_decide');
  });
});
