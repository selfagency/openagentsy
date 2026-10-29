import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPE_DECLARATIONS } from '../src/scope/declarations.ts';

/**
 * Generate the scope declarations file.
 *
 * The declarations live in `src/scope/declarations.ts`, which carries the
 * review material and the reason every entry is there. This file is the
 * ready-to-paste block for `roles.yaml`, and it is what the package reads at
 * runtime, so it has to say the same thing as the TypeScript. It is
 * generated from it, and a hand edit is lost the next time this script
 * runs: change the declarations in the TypeScript and run the script.
 *
 * The output is byte-stable. The roles are in the order the TypeScript
 * declares them, the fields are in the documented order, and the same
 * declarations always produce the same bytes.
 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, 'src', 'scope-declarations.yaml');

/**
 * The header of the generated file.
 *
 * It says what the file is, that it is generated, and what a person is to
 * do with it: paste the block of a role into that role's own `scope:`.
 */
const HEADER = [
  '# The scope declarations of the first-party roles.',
  '#',
  '# GENERATED FILE. It is written by',
  '# `packages/core/scripts/generate-scope-declarations.mjs` from',
  '# `packages/core/src/scope/declarations.ts`, which is the source of truth.',
  '# A hand edit is lost the next time the script runs: change the',
  '# declarations in the TypeScript and run the script.',
  '#',
  '# The file is also the ready-to-paste block for `roles.yaml`. `roles.yaml`',
  "# is a person's file and a protected path, so the declarations live here",
  "# and a person pastes the block of a role into the role's own `scope:`",
  '# when they want it there. A role whose `scope:` is a mapping is read by',
  '# the scope parser; a role whose `scope:` is a sentence keeps the sentence.',
  '#',
  '# The map is keyed by the role id, the same key `roles.yaml` uses, and the',
  '# roles are in the order the TypeScript declares them.',
  '#',
  '# Every block carries five fields:',
  '#',
  '#   purpose          what the role is for, in one sentence',
  '#   in_scope         what the role does, one statement per entry',
  '#   out_of_scope     what the role refuses to do, as the words a request',
  '#                    would carry; an entry with no words to match is a',
  '#                    duty, and its statement is carried instead',
  '#   refusal_pattern  the sentence the refusal is built from',
  '#   redirect         where the refused work goes',
  '#',
  '# The out-of-scope entries are matched against a request by their words,',
  '# so an entry is written as the words a request would carry.',
  '#',
  '# The ethics review of a declaration is not in this file: the answers and',
  '# the reasons live in the TypeScript.',
  '',
].join('\n');

/** A scalar, quoted the way the file quotes it. */
function quote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The out-of-scope entries of one role.
 *
 * An entry that carries match phrases is a refusal, and the phrases are the
 * words a request would carry. An entry with no phrase is a duty: it says
 * what the role holds, and it is carried as its statement.
 */
function outOfScope(declaration) {
  const entries = [];
  for (const entry of declaration.out_of_scope) {
    if (entry.match.length === 0) {
      entries.push(entry.statement);
      continue;
    }
    entries.push(...entry.match);
  }
  return entries;
}

/** The block of one role, as the file writes it. */
function block(declaration) {
  const lines = [`${declaration.role}:`];
  lines.push(`  purpose: ${quote(declaration.purpose)}`);
  lines.push('  in_scope:');
  for (const entry of declaration.in_scope) {
    lines.push(`    - ${quote(entry.statement)}`);
  }
  lines.push('  out_of_scope:');
  for (const entry of outOfScope(declaration)) {
    lines.push(`    - ${quote(entry)}`);
  }
  lines.push(`  refusal_pattern: ${quote(declaration.refusal_pattern)}`);
  lines.push(`  redirect: ${quote(declaration.redirect)}`);
  return lines.join('\n');
}

/** The whole file, as the generator writes it. */
function renderScopeDeclarations(declarations) {
  const blocks = declarations.map((declaration) => block(declaration));
  return `${HEADER}${blocks.join('\n\n')}\n`;
}

/** The file the declarations are written to, when the caller names one. */
function targetPath(argv) {
  const flag = argv.indexOf('--out');
  if (flag === -1) return source;
  const path = argv[flag + 1];
  if (path === undefined) {
    throw new Error('usage: generate-scope-declarations.mjs [--out <file>]');
  }
  return path;
}

const target = targetPath(process.argv.slice(2));
const text = renderScopeDeclarations(SCOPE_DECLARATIONS);

const current = await readFile(target, 'utf8').catch(() => undefined);
if (current === text) {
  console.log(`scope declarations: ${target} is already what the generator writes`);
} else {
  await writeFile(target, text, 'utf8');
  console.log(`scope declarations: wrote ${target}`);
}
