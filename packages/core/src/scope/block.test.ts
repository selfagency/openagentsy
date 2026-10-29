import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseScopeBlock,
  refuseIfOutOfScope,
  ScopeBlockError,
  scopeBlockMatches,
  validateScopeBlock,
} from './block.js';
import { loadScopeBlocks, parseScopeBlocks, scopeBlockForRole } from './declarations-file.js';

/** The declarations file this repository ships. */
const DECLARATIONS_FILE = fileURLToPath(new URL('../scope-declarations.yaml', import.meta.url));

/** A block that passes the validator, for the tests that only need one. */
function validBlock(): {
  purpose: string;
  in_scope: string[];
  out_of_scope: string[];
  refusal_pattern: string;
  redirect: string;
} {
  return {
    purpose: 'Do the one thing.',
    in_scope: ['do the thing'],
    out_of_scope: ['do the other thing'],
    refusal_pattern: "I'm the Role; my job is one thing. [request] is out of my scope. [redirect].",
    redirect: 'Ask a person, or use /oa scope to see what each role does.',
  };
}

describe('the scope block', () => {
  it('reads the five fields a block carries', () => {
    const block = parseScopeBlock(validBlock(), 'roles.lead.scope');
    expect(block.purpose).toBe('Do the one thing.');
    expect(block.in_scope).toEqual(['do the thing']);
    expect(block.out_of_scope).toEqual(['do the other thing']);
    expect(block.refusal_pattern).toContain('[request]');
    expect(block.redirect).toBe('Ask a person, or use /oa scope to see what each role does.');
  });

  it('refuses a block with an empty purpose', () => {
    expect(() => parseScopeBlock({ ...validBlock(), purpose: '' }, 'roles.lead.scope')).toThrow(
      ScopeBlockError,
    );
  });

  it('refuses a block with an empty list', () => {
    expect(() => parseScopeBlock({ ...validBlock(), in_scope: [] }, 'roles.lead.scope')).toThrow(
      ScopeBlockError,
    );
    expect(() =>
      parseScopeBlock({ ...validBlock(), out_of_scope: [] }, 'roles.lead.scope'),
    ).toThrow(ScopeBlockError);
  });

  it('refuses a list that holds something that is not a string', () => {
    expect(() =>
      parseScopeBlock({ ...validBlock(), in_scope: ['ok', 7] }, 'roles.lead.scope'),
    ).toThrow(ScopeBlockError);
  });

  it('refuses a block with no refusal pattern or no redirect', () => {
    expect(() =>
      parseScopeBlock({ ...validBlock(), refusal_pattern: '' }, 'roles.lead.scope'),
    ).toThrow(ScopeBlockError);
    expect(() => parseScopeBlock({ ...validBlock(), redirect: '' }, 'roles.lead.scope')).toThrow(
      ScopeBlockError,
    );
  });

  it('names the field that is wrong', () => {
    try {
      parseScopeBlock({ ...validBlock(), purpose: '' }, 'roles.lead.scope');
      expect.unreachable('the block should have been refused');
    } catch (error) {
      expect((error as Error).message).toContain('roles.lead.scope.purpose');
    }
  });

  it('validates a block without throwing, and lists what is wrong', () => {
    expect(validateScopeBlock(validBlock())).toEqual([]);
    const problems = validateScopeBlock({
      ...validBlock(),
      purpose: '',
      in_scope: [],
      out_of_scope: [],
      refusal_pattern: '',
      redirect: '',
    });
    expect(problems).toHaveLength(5);
    expect(problems.join(' ')).toContain('purpose');
    expect(problems.join(' ')).toContain('in_scope');
    expect(problems.join(' ')).toContain('out_of_scope');
    expect(problems.join(' ')).toContain('refusal_pattern');
    expect(problems.join(' ')).toContain('redirect');
  });
});

describe('the scope match', () => {
  it('matches a request that carries every word of the entry', () => {
    expect(scopeBlockMatches('please write the code for me', 'write code')).toBe(true);
    expect(scopeBlockMatches('implement the feature now', 'implement a feature')).toBe(true);
  });

  it('does not match a request that carries only some of the words', () => {
    expect(scopeBlockMatches('please write the tests', 'write code')).toBe(false);
  });

  it('does not match on a word that only appears inside another word', () => {
    expect(scopeBlockMatches('please encode the payload', 'write code')).toBe(false);
  });

  it('does not match an entry with no word worth matching', () => {
    expect(scopeBlockMatches('anything at all', 'the')).toBe(false);
  });
});

describe('the refusal', () => {
  it('builds the message from the pattern, the request and the redirect', () => {
    const block = validBlock();
    const refusal = refuseIfOutOfScope('please do the other thing', block);
    expect(refusal).toBe(
      "I'm the Role; my job is one thing. please do the other thing is out of my scope. Ask a person, or use /oa scope to see what each role does.",
    );
  });

  it('says nothing when the request is inside the scope', () => {
    expect(refuseIfOutOfScope('please do the thing', validBlock())).toBeUndefined();
  });

  it('is a pure function: the same request gives the same refusal', () => {
    const block = validBlock();
    const first = refuseIfOutOfScope('do the other thing', block);
    const second = refuseIfOutOfScope('do the other thing', block);
    expect(first).toBe(second);
  });
});

describe('the declarations file', () => {
  /**
   * The block of a role.
   *
   * The map is indexed, so the block of a role may be missing. The test
   * says so instead of asserting it away.
   */
  function blockOf(
    blocks: Record<string, ReturnType<typeof validBlock>>,
    role: string,
  ): ReturnType<typeof validBlock> {
    const block = blocks[role];
    if (block === undefined) throw new Error(`no declaration for ${role}`);
    return block;
  }

  it('holds the seven first-party roles', async () => {
    const blocks = await loadScopeBlocks(DECLARATIONS_FILE);
    expect(Object.keys(blocks).sort()).toEqual([
      'advisor',
      'archivist',
      'builder',
      'lead',
      'researcher',
      'reviewer',
      'scout',
    ]);
  });

  it('holds no block for the offload, which is a package and not a role', async () => {
    const blocks = await loadScopeBlocks(DECLARATIONS_FILE);
    expect(blocks.offload).toBeUndefined();
  });

  it('validates every declaration it holds', async () => {
    const blocks = await loadScopeBlocks(DECLARATIONS_FILE);
    for (const [role, block] of Object.entries(blocks)) {
      expect(validateScopeBlock(block), `${role} does not validate`).toEqual([]);
    }
  });

  it('gives every role a refusal that names the request and the redirect', async () => {
    const blocks = await loadScopeBlocks(DECLARATIONS_FILE);
    for (const [role, block] of Object.entries(blocks)) {
      expect(block.refusal_pattern, `${role} has no request placeholder`).toContain('[request]');
      expect(block.refusal_pattern, `${role} has no redirect placeholder`).toContain('[redirect]');
      expect(block.redirect.length, `${role} has no redirect`).toBeGreaterThan(0);
    }
  });

  it('says something different for each role', async () => {
    const blocks = await loadScopeBlocks(DECLARATIONS_FILE);
    const purposes = Object.values(blocks).map((block) => block.purpose);
    expect(new Set(purposes).size).toBe(purposes.length);
  });

  it('keeps the lead out of the code and the builder inside its lease', async () => {
    const blocks = await loadScopeBlocks(DECLARATIONS_FILE);
    const lead = blockOf(blocks, 'lead');
    const builder = blockOf(blocks, 'builder');
    expect(refuseIfOutOfScope('please write the code for the parser', lead)).toContain(
      'out of my scope',
    );
    expect(refuseIfOutOfScope('implement the assigned bean', builder)).toBeUndefined();
    expect(refuseIfOutOfScope('please edit an unleased file', builder)).toContain(
      'out of my scope',
    );
  });

  it('keeps the scout out of the files and the researcher out of the guesswork', async () => {
    const blocks = await loadScopeBlocks(DECLARATIONS_FILE);
    const scout = blockOf(blocks, 'scout');
    const researcher = blockOf(blocks, 'researcher');
    expect(refuseIfOutOfScope('please apply a patch to the file', scout)).toContain(
      'out of my scope',
    );
    expect(refuseIfOutOfScope('fetch the documentation and cite it', researcher)).toBeUndefined();
    expect(refuseIfOutOfScope('guess an api that you did not read', researcher)).toContain(
      'out of my scope',
    );
  });

  it('keeps the reviewer out of the fix and the advisor out of the decision', async () => {
    const blocks = await loadScopeBlocks(DECLARATIONS_FILE);
    const reviewer = blockOf(blocks, 'reviewer');
    const advisor = blockOf(blocks, 'advisor');
    expect(refuseIfOutOfScope('fix the code yourself', reviewer)).toContain('out of my scope');
    expect(refuseIfOutOfScope('lay out the options for the fork', advisor)).toBeUndefined();
    expect(refuseIfOutOfScope('make the decision for us', advisor)).toContain('out of my scope');
  });

  it('keeps the archivist out of the code', async () => {
    const blocks = await loadScopeBlocks(DECLARATIONS_FILE);
    const archivist = blockOf(blocks, 'archivist');
    expect(refuseIfOutOfScope('write the code for the fix', archivist)).toContain(
      'out of my scope',
    );
  });

  it('is read as a map keyed by the role id', async () => {
    const text = await readFile(DECLARATIONS_FILE, 'utf8');
    const blocks = parseScopeBlocks(text);
    expect(blockOf(blocks, 'lead').purpose.length).toBeGreaterThan(0);
    expect(scopeBlockForRole(blocks, 'oa-lead')).toBe(blocks.lead);
    expect(scopeBlockForRole(blocks, 'nobody')).toBeUndefined();
  });

  it('refuses a declarations file that does not hold a map', async () => {
    await expect(loadScopeBlocks(DECLARATIONS_FILE)).resolves.toBeDefined();
    expect(() => parseScopeBlocks('- not a map\n')).toThrow(ScopeBlockError);
  });
});
