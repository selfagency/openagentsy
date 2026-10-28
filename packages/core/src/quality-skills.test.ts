import { describe, expect, it } from 'vitest';
import {
  CODE_EXTENSIONS,
  COPY_EXTENSIONS,
  kindOf,
  selectProseSkills,
  selectQualitySkills,
  UI_DESIGN_FILES,
  UI_EXTENSIONS,
} from './quality-skills.js';

describe('selectQualitySkills', () => {
  it('loads no skill for a change that touches no quality file', () => {
    const skills = selectQualitySkills([
      { path: 'packages/core/src/index.ts', lines: ['export const version = 1;'] },
    ]);
    expect(skills).toEqual([]);
  });

  it('loads oa-ui for a stylesheet change', () => {
    const skills = selectQualitySkills([
      { path: 'packages/app/src/app.css', lines: ['.card { padding: 1rem; }'] },
    ]);
    expect(skills).toEqual(['oa-ui']);
  });

  it('loads oa-ui and oa-copy for a markup change', () => {
    const skills = selectQualitySkills([
      { path: 'packages/app/src/App.tsx', lines: ['<h1>Save</h1>'] },
    ]);
    expect(skills).toEqual(['oa-ui', 'oa-copy']);
  });

  it('loads oa-copy for a prose change', () => {
    const skills = selectQualitySkills([{ path: 'README.md', lines: ['# The readme'] }]);
    expect(skills).toEqual(['oa-copy']);
  });

  it('loads oa-comments for a comment-only change', () => {
    const skills = selectQualitySkills([
      { path: 'packages/core/src/index.ts', lines: ['// The version of the package.'] },
    ]);
    expect(skills).toEqual(['oa-comments']);
  });

  it('loads oa-ui for a design file, and not oa-copy', () => {
    const skills = selectQualitySkills([{ path: 'DESIGN.md', lines: ['# The design'] }]);
    expect(skills).toEqual(['oa-ui']);
  });

  it('reads a heading as copy and not as a comment', () => {
    const skills = selectQualitySkills([{ path: 'README.md', lines: ['# The readme'] }]);
    expect(skills).not.toContain('oa-comments');
  });

  it('does not read a comment in a prose file as a comment', () => {
    const skills = selectQualitySkills([
      { path: 'docs/guide.md', lines: ['<!-- a note for the reader -->'] },
    ]);
    expect(skills).toEqual(['oa-copy']);
  });

  it('loads no skill when the change has no lines and the file is code', () => {
    const skills = selectQualitySkills([{ path: 'packages/core/src/index.ts' }]);
    expect(skills).toEqual([]);
  });

  it('loads oa-ui when the change has no lines and the file is a stylesheet', () => {
    const skills = selectQualitySkills([{ path: 'packages/app/src/app.css' }]);
    expect(skills).toEqual(['oa-ui']);
  });

  it('loads nothing for a change that mixes code and a comment', () => {
    const skills = selectQualitySkills([
      { path: 'packages/core/src/index.ts', lines: ['counter += 1;', '// a note'] },
    ]);
    expect(skills).toEqual([]);
  });

  it('loads oa-comments for a blank line beside a comment', () => {
    const skills = selectQualitySkills([
      { path: 'packages/core/src/index.ts', lines: ['', '// a note', ''] },
    ]);
    expect(skills).toEqual(['oa-comments']);
  });

  it('loads oa-comments for a JavaScript comment in a component', () => {
    const skills = selectQualitySkills([
      { path: 'packages/app/src/App.tsx', lines: ['// the title of the panel'] },
    ]);
    expect(skills).toEqual(['oa-ui', 'oa-copy', 'oa-comments']);
  });

  it('does not load oa-comments for a file the comment rules do not read', () => {
    const skills = selectQualitySkills([
      { path: 'packages/app/src/app.css', lines: ['/* the card padding */'] },
    ]);
    expect(skills).toEqual(['oa-ui']);
  });

  it('loads the skill once for a change that touches two files', () => {
    const skills = selectQualitySkills([
      { path: 'packages/app/src/app.css', lines: ['.card { padding: 1rem; }'] },
      { path: 'packages/app/src/theme.css', lines: ['.card { margin: 0; }'] },
    ]);
    expect(skills).toEqual(['oa-ui']);
  });
});

describe('the conditions', () => {
  it('reads the kinds the mechanical rules read', () => {
    expect(kindOf('packages/app/src/app.css')).toBe('css');
    expect(kindOf('packages/app/src/App.tsx')).toBe('markup');
    expect(kindOf('packages/app/src/page.html')).toBe('html');
    expect(kindOf('packages/core/src/index.ts')).toBe('code');
    expect(kindOf('README.md')).toBe('prose');
    expect(kindOf('scripts/run.sh')).toBe('other');
  });

  it('keeps the code kinds out of the copy and the UI kinds', () => {
    for (const extension of CODE_EXTENSIONS) {
      expect(UI_EXTENSIONS).not.toContain(extension);
      expect(COPY_EXTENSIONS).not.toContain(extension);
    }
  });

  it('names the design files the routing names', () => {
    expect(UI_DESIGN_FILES).toEqual(['DESIGN.md']);
  });
});

describe('selectProseSkills', () => {
  it('loads oa-copy for agent prose', () => {
    expect(selectProseSkills()).toEqual(['oa-copy']);
  });
});
