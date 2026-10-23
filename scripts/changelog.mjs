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

const tags = git(['tag', '--list', '--sort=-v:refname', 'v*'])
  .split('\n')
  .filter((line) => line !== '');

const to = tags[0] ?? 'HEAD';
const from = tags[1];
const range = from === undefined ? ['HEAD'] : [`${from}..HEAD`];
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

const version =
  from === undefined
    ? // No tag yet: this is the first release, so it takes the version the
      // root manifest names.
      JSON.parse(readFileSync('package.json', 'utf8')).version
    : to.replace(/^v/, '');
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

const header = '# Changelog\n\nEvery release, from the commits that made it.\n';
writeFileSync('CHANGELOG.md', `${header}\n${lines.join('\n')}`, 'utf8');
console.log(`CHANGELOG.md now holds ${version}`);
