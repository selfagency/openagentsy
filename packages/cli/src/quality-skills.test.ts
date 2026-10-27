import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRoles,
  type RolesFile,
  selectQualitySkills,
  UI_DESIGN_FILES,
  UI_EXTENSIONS,
} from '@openagentsy/core';
import { describe, expect, it } from 'vitest';
import { runBuild } from './commands/build.js';
import { renderPrompt } from './generate/prompt.js';

/** The roles file this repository ships. */
const SHIPPED_ROLES = fileURLToPath(new URL('../../../roles.yaml', import.meta.url));

/** The root of this repository. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The roles that carry the routing. */
const ROUTED_ROLES = ['lead', 'builder'];

/**
 * The measure: one token per word, per digit group and per punctuation
 * mark, with the whitespace in front of a token carried by it.
 *
 * This is the shape of the cl100k_base pre-tokenizer for English prose:
 * a word is one token, "user-facing" is three, ".css" is two, and a
 * number is split into groups of three. The routing is measured with it
 * and with the four-characters-per-token rule, so the claim holds under
 * both.
 */
function countTokens(text: string): number {
  const pattern = /\s*[A-Za-z]+(?:'[A-Za-z]+)*|\s*\d+|\s*[^\sA-Za-z0-9]/g;
  let count = 0;
  for (const match of text.match(pattern) ?? []) {
    const trimmed = match.trim();
    if (trimmed === '') continue;
    count += /^\d+$/.test(trimmed) ? Math.ceil(trimmed.length / 3) : 1;
  }
  return count;
}

/** The routing of one role. */
function routingOf(roles: RolesFile, name: string): string {
  const role = roles.roles[name];
  if (!role) throw new Error(`no ${name} role`);
  if (role.skillRouting === undefined) throw new Error(`the ${name} role has no routing`);
  return role.skillRouting.trim();
}

describe('the quality routing', () => {
  it('costs the Lead and the builder at most 80 tokens', async () => {
    const roles = await loadRoles(SHIPPED_ROLES);
    for (const name of ROUTED_ROLES) {
      const routing = routingOf(roles, name);
      expect(countTokens(routing)).toBeLessThanOrEqual(80);
      expect(Math.ceil(routing.length / 4)).toBeLessThanOrEqual(80);
    }
  });

  it('names the conditions the module implements', async () => {
    const roles = await loadRoles(SHIPPED_ROLES);
    const routing = routingOf(roles, 'lead');
    for (const skill of ['oa-ui', 'oa-copy', 'oa-comments']) {
      expect(routing).toContain(skill);
    }
    for (const extension of UI_EXTENSIONS) {
      expect(routing).toContain(extension);
    }
    for (const designFile of UI_DESIGN_FILES) {
      expect(routing).toContain(designFile);
    }
    expect(routing).toContain('user-facing copy');
    expect(routing).toContain('agent prose');
    expect(routing).toContain('comment');
  });

  it('gives the Lead and the builder the same routing', async () => {
    const roles = await loadRoles(SHIPPED_ROLES);
    expect(routingOf(roles, 'lead')).toBe(routingOf(roles, 'builder'));
  });

  it('keeps the routing off the roles that write no UI, copy or comments', async () => {
    const roles = await loadRoles(SHIPPED_ROLES);
    for (const name of ['scout', 'researcher', 'reviewer', 'advisor', 'archivist']) {
      expect(roles.roles[name]?.skillRouting).toBeUndefined();
    }
  });

  it('carries the routing into the prompt', async () => {
    const roles = await loadRoles(SHIPPED_ROLES);
    const lead = roles.roles.lead;
    if (!lead) throw new Error('no lead role');
    const prompt = renderPrompt(lead);
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('oa-ui');
  });

  it('leaves the prompt of a role with no routing alone', async () => {
    const roles = await loadRoles(SHIPPED_ROLES);
    const reviewer = roles.roles.reviewer;
    if (!reviewer) throw new Error('no reviewer role');
    expect(renderPrompt(reviewer)).not.toContain('## Skills');
  });
});

describe('the selection the routing names', () => {
  it('selects no skill for a change that touches no quality file', () => {
    const skills = selectQualitySkills([
      { path: 'packages/core/src/index.ts', lines: ['export const version = 1;'] },
    ]);
    expect(skills).toEqual([]);
  });

  it('selects oa-ui for a stylesheet change', () => {
    const skills = selectQualitySkills([
      { path: 'packages/app/src/app.css', lines: ['.card { padding: 1rem; }'] },
    ]);
    expect(skills).toEqual(['oa-ui']);
  });

  it('selects oa-ui and oa-copy for a component change', () => {
    const skills = selectQualitySkills([
      { path: 'packages/app/src/App.tsx', lines: ['<h1>Save</h1>'] },
    ]);
    expect(skills).toEqual(['oa-ui', 'oa-copy']);
  });

  it('selects oa-copy for a copy-bearing change', () => {
    const skills = selectQualitySkills([{ path: 'README.md', lines: ['# The readme'] }]);
    expect(skills).toEqual(['oa-copy']);
  });

  it('selects oa-comments for a comment-only change', () => {
    const skills = selectQualitySkills([
      { path: 'packages/core/src/index.ts', lines: ['// The version of the package.'] },
    ]);
    expect(skills).toEqual(['oa-comments']);
  });
});

describe('the build', () => {
  it('copies the reference files of a skill, and not only its SKILL.md', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'oa-skills-'));
    const result = await runBuild({ root: REPO_ROOT, target: 'v1', outDir });
    expect(result.skills).toContain('oa-ui');
    expect(result.skills).toContain('oa-copy');
    expect(result.skills).toContain('oa-comments');
    expect(existsSync(join(outDir, 'skills', 'oa-ui', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(outDir, 'skills', 'oa-ui', 'references', 'purpose-and-dials.md'))).toBe(
      true,
    );
    expect(existsSync(join(outDir, 'skills', 'oa-copy', 'references', 'prose.md'))).toBe(true);
    expect(existsSync(join(outDir, 'skills', 'oa-comments', 'references', 'tells.md'))).toBe(true);
  });
});
