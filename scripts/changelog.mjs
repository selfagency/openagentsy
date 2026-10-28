import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The changelog, from the commit log.
 *
 * The commits are the record; this turns them into the file a reader looks
 * at. A conventional commit is a type, a scope and a summary; the type
 * decides the section it lands in, and the scope is kept with the summary
 * because it says which part of the system changed.
 */
const TYPES = {
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Improved',
  refactor: 'Changed',
  docs: 'Documented',
  test: 'Tested',
  build: 'Built',
  ci: 'Built',
  chore: 'Kept',
};

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/**
 * The version this release carries.
 *
 * The tag does not exist yet when this runs: the workflow checks that the
 * tag names the version every manifest carries, and the tag is cut from the
 * commit this script makes. So the version comes from the manifest, and
 * the tag follows it.
 */
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

const tags = git(['tag', '--list', '--sort=-v:refname', 'v*'])
  .split('\n')
  .filter((line) => line !== '');

/**
 * The commits of this release: everything since the last tag.
 *
 * The last tag is the one before this release. The range used to start at
 * the tag before that, which put the previous release's commits into this
 * release's notes, and with one tag there was no range at all, so every
 * commit since the beginning was listed under the release.
 */
const range = tags.length > 0 ? [`${tags[0]}..HEAD`] : ['HEAD'];
const log = git(['log', range.join(' '), '--no-merges', '--pretty=format:%H%x1f%s%x1f%b%x1e']);

const groups = new Map();
const breaking = [];

for (const record of log.split('\x1e')) {
  const trimmed = record.trim();
  if (trimmed === '') continue;
  const [hash, subject, body] = trimmed.split('\x1f');
  const match = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/.exec(subject);
  if (!match) continue;
  const [, type, scope, bang, summary] = match;
  const section = TYPES[type];
  if (section === undefined) continue;
  if (!groups.has(section)) groups.set(section, []);
  groups
    .get(section)
    .push(`- ${scope ? `**${scope}**: ` : ''}${summary} (\`${hash.slice(0, 7)}\`)`);
  if (bang === '!' || /BREAKING CHANGE/.test(body ?? '')) {
    breaking.push(`- ${summary} (\`${hash.slice(0, 7)}\`)`);
  }
}

const date = new Date().toISOString().slice(0, 10);
const lines = [`## ${version} - ${date}`, ''];

if (groups.size === 0) {
  lines.push('No conventional commits in this range.', '');
} else {
  for (const [section, entries] of groups) {
    lines.push(`### ${section}`, '', ...entries, '');
  }
}
if (breaking.length > 0) {
  lines.push('### Breaking', '', ...breaking, '');
}

/**
 * The sections of a changelog file.
 *
 * The file is a header and then a run of sections, and a section starts at
 * a line that begins with two hashes.
 */
function sections(text) {
  const found = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = [line];
      found.push(current);
      continue;
    }
    if (current !== null) current.push(line);
  }
  return found;
}

/**
 * The file: the new section, and the sections of the releases before it.
 *
 * The old releases stay: a reader who wants to know what 0.1.1 changed
 * finds it there. The "Unreleased" section goes, because the commits it
 * listed are the commits this release carries, and a section for this
 * version that is already there goes too, because this is a re-run.
 */
const header = '# Changelog\n\nEvery release, from the commits that made it.\n';
const existing = readFileSync('CHANGELOG.md', 'utf8');
const kept = sections(existing)
  .filter((section) => {
    const heading = section[0] ?? '';
    if (heading === '## Unreleased') return false;
    return !heading.startsWith(`## ${version} `) && heading !== `## ${version}`;
  })
  .map((section) => `${section.join('\n').replace(/\n+$/, '')}\n`)
  .join('\n');

writeFileSync('CHANGELOG.md', `${header}\n${lines.join('\n')}\n${kept}`, 'utf8');
console.log(`CHANGELOG.md now holds ${version}`);
