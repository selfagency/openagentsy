import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapturedFrame, RGBA } from '@opentui/core';
import type { JSX } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { accountabilityTree } from './blocks/accountability.render.js';
import { boardTree } from './blocks/board.render.js';
import { budgetTree } from './blocks/budget.render.js';
import { footprintTree } from './blocks/footprint.render.js';
import { memoryTree } from './blocks/memory.render.js';
import { tasksTree } from './blocks/tasks.render.js';
import { collapseStore } from './persist.js';
import {
  ACCOUNTABILITY,
  BOARD,
  BUDGET,
  CONFIG,
  MEMORY,
  MESSAGES,
  TASKS,
} from './testing/fixtures.js';
import {
  ERROR,
  type FakeTheme,
  fakeHost,
  type Host,
  renderFrame,
  renderSpans,
  WARNING,
} from './testing/harness.js';

/**
 * The framing rules of the sidebar, as tests (§7.6).
 *
 * The rules are three: the copy does not blame the person, the blocks paint
 * with the two normal colours, and a block reads no other colour from the
 * theme. A rule that nothing checks is a note, so each rule is a check here,
 * and each check is shown to fail when the rule is broken: the word check
 * against a copy with a banned word in it, the colour check against a frame
 * painted in the banned colour, and the source check against a block whose
 * source reads one.
 */

/** The words the plan bans (§7.6). */
const BANNED_WORDS = ['you', 'your fault', 'streak', 'today you'] as const;

/** The comparisons with other users the plan bans (§7.6). */
const BANNED_COMPARISONS = ['other users', 'than others', 'other people'] as const;

/** The theme paths a block may read (§7.6). */
const ALLOWED_THEME_PATHS: readonly string[] = ['theme.text.base', 'theme.text.muted'];

/** The colours the plan bans (§7.6), and the names they are reported under. */
const BANNED_COLOURS: readonly { readonly name: string; readonly colour: RGBA }[] = [
  { name: 'error', colour: ERROR },
  { name: 'warning', colour: WARNING },
];

/** The directory this file lives in. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** A block, and the tree that draws it. */
interface Block {
  /** The name of the block. */
  readonly name: string;
  /** The tree the block draws. */
  readonly tree: () => JSX.Element;
}

/** A host that holds the fixture messages, and paints with the given colours. */
function fixtureHost(theme?: FakeTheme): Host {
  return fakeHost({ messages: MESSAGES, ...(theme === undefined ? {} : { theme }) });
}

/** Every block the sidebar draws, drawn from the fixtures. */
function blocks(host: Host): Block[] {
  const collapse = collapseStore(host.context);
  return [
    { name: 'board', tree: () => boardTree(host.context, BOARD, collapse) },
    { name: 'tasks', tree: () => tasksTree(host.context, TASKS, collapse) },
    { name: 'budget', tree: () => budgetTree(host.context, BUDGET, collapse) },
    { name: 'memory', tree: () => memoryTree(host.context, MEMORY, collapse) },
    {
      name: 'accountability',
      tree: () => accountabilityTree(host.context, ACCOUNTABILITY, collapse),
    },
    { name: 'footprint', tree: () => footprintTree(host.context, CONFIG, collapse) },
  ];
}

/** The frame the memory inbox block draws. */
async function memoryFrame(host: Host): Promise<string> {
  const collapse = collapseStore(host.context);
  return renderFrame(() => memoryTree(host.context, MEMORY, collapse));
}

/** The spans the memory inbox block paints. */
async function memorySpans(host: Host): Promise<CapturedFrame> {
  const collapse = collapseStore(host.context);
  return renderSpans(() => memoryTree(host.context, MEMORY, collapse));
}

/** The source of a block, as the scan reads it. */
async function blockSource(name: string): Promise<string> {
  const dir = join(HERE, 'blocks');
  const names = (await readdir(dir)).filter((entry) => entry.endsWith('.tsx')).sort();
  const found = names.includes(name) ? names.filter((entry) => entry === name) : [];
  const file = found[0];
  if (file === undefined) return '';
  return readFile(join(dir, file), 'utf8');
}

/** Every block source, as the scan reads it. */
async function blockSources(): Promise<{ name: string; source: string }[]> {
  const dir = join(HERE, 'blocks');
  const names = (await readdir(dir)).filter((entry) => entry.endsWith('.tsx')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, source: await readFile(join(dir, name), 'utf8') })),
  );
}

/** The phrase the plan bans, as a pattern that matches a word and not a part of one. */
function patternFor(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/** The banned phrases a copy holds. */
function bannedWordsIn(text: string): string[] {
  const phrases = [...BANNED_WORDS, ...BANNED_COMPARISONS];
  return phrases.filter((phrase) => patternFor(phrase).test(text));
}

/** The text a frame holds. */
function frameText(frame: CapturedFrame): string {
  return frame.lines.flatMap((line) => line.spans.map((span) => span.text)).join('');
}

/** The banned colours a frame was painted with. */
function bannedColoursIn(frame: CapturedFrame): string[] {
  const found = new Set<string>();
  for (const line of frame.lines) {
    for (const span of line.spans) {
      for (const banned of BANNED_COLOURS) {
        if (span.fg.equals(banned.colour)) found.add(banned.name);
      }
    }
  }
  return [...found];
}

/** The end of a string literal that starts at an index. */
function endOfString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

/**
 * The end of a comment that starts at an index, and the index after it.
 *
 * A line comment ends at the newline that closes it and a block comment at
 * the marker that closes it.
 */
function endOfComment(source: string, start: number): number {
  if (source[start + 1] === '/') {
    const end = source.indexOf('\n', start);
    return end === -1 ? source.length : end;
  }
  const end = source.indexOf('*/', start + 2);
  return end === -1 ? source.length : end + 2;
}

/**
 * The source of a file, with its comments and its strings blanked out.
 *
 * A theme path is code, so a comment that names one and a string that holds
 * one are not a path a block reads. The blanks keep the line numbers.
 */
function codeOnly(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      const end = endOfComment(source, index);
      out += ' '.repeat(end - index);
      index = end;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const end = endOfString(source, index);
      out += ' '.repeat(end - index);
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The theme paths a source reads. */
function themePaths(source: string): string[] {
  return [...codeOnly(source).matchAll(/\btheme(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g)].map(
    (match) => match[0],
  );
}

/** The theme paths a source reads that the rules ban. */
function bannedThemePaths(source: string): string[] {
  return themePaths(source).filter((path) => !ALLOWED_THEME_PATHS.includes(path));
}

describe('the framing rules of the sidebar', () => {
  it('says nothing that blames the person', async () => {
    for (const block of blocks(fixtureHost())) {
      const text = await renderFrame(block.tree);

      expect(text.trim().length, `${block.name} drew nothing`).toBeGreaterThan(0);
      expect(bannedWordsIn(text), `${block.name} blames the person`).toEqual([]);
    }
  });

  it('paints with no colour the rules ban', async () => {
    for (const block of blocks(fixtureHost())) {
      const frame = await renderSpans(block.tree);

      expect(frameText(frame).trim().length, `${block.name} painted nothing`).toBeGreaterThan(0);
      expect(bannedColoursIn(frame), `${block.name} paints a banned colour`).toEqual([]);
    }
  });

  it('reads no colour from the theme but the two normal ones', async () => {
    const files = await blockSources();

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(bannedThemePaths(file.source), `${file.name} reads a banned colour`).toEqual([]);
    }
  });

  it('catches the copy that blames the person', async () => {
    const text = await memoryFrame(fixtureHost());

    expect(bannedWordsIn(`${text} today you broke the rule`)).toContain('you');
  });

  it('catches the frame painted in the error colour', async () => {
    const frame = await memorySpans(fixtureHost({ base: ERROR }));

    expect(bannedColoursIn(frame)).toContain('error');
  });

  it('catches the frame painted in the warning colour', async () => {
    const frame = await memorySpans(fixtureHost({ base: WARNING }));

    expect(bannedColoursIn(frame)).toContain('warning');
  });

  it('catches the source that reads a banned colour', async () => {
    const source = await blockSource('footprint.tsx');
    const broken = source.replace('theme.text.base', 'theme.text.feedback.error.base');

    expect(bannedThemePaths(broken)).toContain('theme.text.feedback.error.base');
  });

  it('catches the copy that compares the person with others', async () => {
    const text = await memoryFrame(fixtureHost());

    expect(bannedWordsIn(`${text} more than others did`)).toContain('than others');
  });
});
