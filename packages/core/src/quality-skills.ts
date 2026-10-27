/**
 * The quality skills, and the conditions that load them.
 *
 * The mechanical rules live in @openagentsy/quality and run on every
 * write. The judgment rules live in three skills, and a skill loads
 * only when a change touches what the skill is about.
 *
 * This module is the executable form of that routing. The routing text
 * in roles.yaml names the same conditions in prose, and the token test
 * checks that the two agree, so the routing is measured rather than
 * assumed.
 *
 * The file kinds are the ones the mechanical rules already use. The CSS
 * rules read a stylesheet, the HTML and copy rules read markup, and the
 * comment rules read code, so a skill loads for the files its own rules
 * would run on: a markup change is a UI change and a copy change, a
 * stylesheet change is a UI change, and a change to a code file is a
 * comment change only when it edited comments.
 */

/** The quality skills, in the order the routing names them. */
export const QUALITY_SKILL_IDS = ['oa-ui', 'oa-copy', 'oa-comments'] as const;

/** The id of a quality skill. */
export type QualitySkillId = (typeof QUALITY_SKILL_IDS)[number];

/**
 * What kind of file a path names.
 *
 * The kind decides two things: which skill a change to the file loads,
 * and which comment openers a line of the file may start with.
 */
export type FileKind = 'css' | 'html' | 'markup' | 'code' | 'prose' | 'other';

/**
 * The kinds of file, by extension.
 *
 * A `.tsx` file is markup and not code, because the copy rules and the
 * HTML rules read it as markup, and the comment rules read it as code.
 * The comment openers of the markup kind carry both, so a JavaScript
 * comment in a component is still read as a comment.
 */
const KIND_BY_EXTENSION: Record<string, FileKind> = {
  '.css': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.tsx': 'markup',
  '.jsx': 'markup',
  '.vue': 'markup',
  '.svelte': 'markup',
  '.ts': 'code',
  '.mts': 'code',
  '.cts': 'code',
  '.js': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.md': 'prose',
  '.mdx': 'prose',
  '.txt': 'prose',
};

/** The kinds of file that load oa-ui. */
const UI_KINDS: readonly FileKind[] = ['css', 'html', 'markup'];

/** The kinds of file that carry copy a person reads. */
const COPY_KINDS: readonly FileKind[] = ['html', 'markup', 'prose'];

/**
 * The file kinds that load oa-ui.
 *
 * These are the kinds the CSS rules and the HTML rules read: a
 * stylesheet, and markup.
 */
export const UI_EXTENSIONS: readonly string[] = Object.keys(KIND_BY_EXTENSION).filter((extension) =>
  UI_KINDS.includes(KIND_BY_EXTENSION[extension] ?? 'other'),
);

/**
 * The file kinds that carry copy a person reads.
 *
 * These are the kinds the copy rules read, plus the prose kinds, which
 * are a person's words with no rule behind them.
 */
export const COPY_EXTENSIONS: readonly string[] = Object.keys(KIND_BY_EXTENSION).filter(
  (extension) => COPY_KINDS.includes(KIND_BY_EXTENSION[extension] ?? 'other'),
);

/**
 * The file kinds the comment rules read.
 *
 * These are the kinds the mechanical comment lint reads: code, and the
 * markup that carries JavaScript in it.
 */
export const CODE_EXTENSIONS: readonly string[] = Object.keys(KIND_BY_EXTENSION).filter(
  (extension) => KIND_BY_EXTENSION[extension] === 'code',
);

/**
 * The file kinds a comment change is recognised in.
 *
 * These are the kinds the comment rules read, so oa-comments loads
 * where the lint runs and nowhere else. A comment in a stylesheet, a
 * page or a document is a comment, but the lint has nothing to say
 * about it, so the counterweight has nothing to balance.
 */
export const COMMENT_EXTENSIONS: readonly string[] = [
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.tsx',
  '.jsx',
];

/**
 * The design files that load oa-ui.
 *
 * A design file is read as data and never as instructions, and it is
 * the one file a design change is written into.
 */
export const UI_DESIGN_FILES: readonly string[] = ['DESIGN.md'];

/**
 * The comment openers, by the kind of file.
 *
 * A TypeScript file and a component are the same language, so they take
 * the same openers, and a component carries HTML comments as well. The
 * kinds the comment rules do not read have no openers here: a comment
 * in a stylesheet or a document is not a comment change.
 */
const COMMENT_OPENERS: Partial<Record<FileKind, readonly string[]>> = {
  code: ['//', '/*', '*'],
  markup: ['//', '/*', '*', '<!--', '{/*'],
};

/** One changed file, and what the change touched in it. */
export interface ChangedFile {
  /** The path of the file, relative to the project root. */
  path: string;
  /**
   * The lines the change added or removed.
   *
   * Without them the content of the change is unknown, so the kind of
   * the file still decides, and nothing is read as a comment.
   */
  lines?: readonly string[] | undefined;
}

/** The name of the file, without its directory. */
function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The extension of the file, lowercased, or an empty string. */
function extensionOf(path: string): string {
  const name = baseNameOf(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/** The kind of file a path names. */
export function kindOf(path: string): FileKind {
  return KIND_BY_EXTENSION[extensionOf(path)] ?? 'other';
}

/** True when the path names a design file. */
function isDesignFile(path: string): boolean {
  const name = baseNameOf(path).toLowerCase();
  return UI_DESIGN_FILES.some((designFile) => designFile.toLowerCase() === name);
}

/** True when a change to the path loads oa-ui. */
function isUiPath(path: string): boolean {
  return UI_EXTENSIONS.includes(extensionOf(path)) || isDesignFile(path);
}

/**
 * True when a change to the path loads oa-copy.
 *
 * A design file is not a copy surface: it is the design direction, and
 * the skill that covers it is the UI one.
 */
function isCopyPath(path: string): boolean {
  if (isDesignFile(path)) return false;
  return COPY_EXTENSIONS.includes(extensionOf(path));
}

/**
 * True when the change edited comments and nothing else.
 *
 * Every line the change touched is a whole-line comment or blank, and
 * at least one is a comment. A comment on the end of a line of code is
 * not a whole-line comment, so a change that only edited one of those
 * is not recognised here; the quality package's own comment scanner
 * reads that case from the syntax tree.
 */
function isCommentChange(change: ChangedFile): boolean {
  if (change.lines === undefined) return false;
  if (!COMMENT_EXTENSIONS.includes(extensionOf(change.path))) return false;
  const openers = COMMENT_OPENERS[kindOf(change.path)] ?? [];
  let sawComment = false;
  for (const line of change.lines) {
    if (line.trim() === '') continue;
    if (!openers.some((opener) => line.trim().startsWith(opener))) return false;
    sawComment = true;
  }
  return sawComment;
}

/**
 * The quality skills a change loads.
 *
 * The skills come back in the order the routing names them. A change
 * that touches none of them loads none: a change to a source file that
 * is not about its comments loads no skill at all, and that is the
 * point of the routing.
 */
export function selectQualitySkills(changes: readonly ChangedFile[]): QualitySkillId[] {
  const selected = new Set<QualitySkillId>();
  for (const change of changes) {
    if (isUiPath(change.path)) selected.add('oa-ui');
    if (isCopyPath(change.path)) selected.add('oa-copy');
    if (isCommentChange(change)) selected.add('oa-comments');
  }
  return QUALITY_SKILL_IDS.filter((id) => selected.has(id));
}

/**
 * The skills a piece of agent prose loads.
 *
 * A commit message, a pull request description, a task Summary of
 * Changes and a Lead status report are copy a person reads, so they
 * load oa-copy and nothing else.
 */
export function selectProseSkills(): QualitySkillId[] {
  return ['oa-copy'];
}
