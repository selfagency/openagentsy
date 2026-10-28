// Stage a package for publishing.
//
// The publish runs outside the repository tree. npm reads the nearest
// package.json's devEngines and refuses to run in a tree whose root asks
// for another package manager, and the root of this repository asks for
// bun; a staged copy has no root above it, so npm has nothing to refuse.
//
// The staged manifest carries the versions the workspace protocol named,
// which is what npm writes when it publishes a workspace package: the
// range becomes the real version of the local package.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const [source, stage, root = join(import.meta.dirname, '..')] = process.argv.slice(2);

if (source === undefined || stage === undefined) {
  console.error('usage: stage-package.mjs <package-directory> <stage-directory> [workspace-root]');
  process.exit(1);
}

/** The workspace packages and the versions they carry. */
function workspaceVersions(at) {
  const versions = new Map();
  const packages = join(at, 'packages');
  if (!existsSync(packages)) return versions;
  for (const directory of readdirSync(packages)) {
    const manifest = join(packages, directory, 'package.json');
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
      versions.set(parsed.name, parsed.version);
    }
  }
  return versions;
}

const versions = workspaceVersions(root);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(source, stage, {
  recursive: true,
  filter: (path) => !path.includes('node_modules'),
});

const manifestPath = join(stage, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const field of [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]) {
  const block = manifest[field];
  if (block === undefined || block === null) continue;
  for (const [name, range] of Object.entries(block)) {
    if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
    const version = versions.get(name);
    if (version === undefined) continue;
    block[name] = range === 'workspace:*' ? version : `^${version}`;
  }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(stage);
