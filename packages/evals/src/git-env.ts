/**
 * The git variables that point a command at a repository.
 *
 * A git that runs a hook sets these in the environment of the hook, and
 * anything spawned inside that hook inherits them: the child then addresses
 * the repository of the hook instead of the one it was asked about. The
 * suite runs inside a hook when it runs from a commit, and a case whose
 * git command inherited them wrote into the repository that started the
 * suite (measured 2026-10-27: the outer repository's config came back with
 * core.bare set and a test identity in it, and `git status` refused to run
 * there afterwards).
 */
export const GIT_REPOSITORY_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
] as const;

/** The environment a git child gets: the caller's, without the git variables. */
export function gitFreeEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = { ...env };
  for (const name of GIT_REPOSITORY_VARS) delete copy[name];
  return copy;
}
