import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { loadRoles } from '../roles.js';
import type { RolesFile } from '../types.js';
import { parseScopeBlock, type ScopeBlock, ScopeBlockError } from './block.js';
import { scopeRoleKey } from './declarations.js';

/**
 * The declarations file: the scope blocks of the roles, keyed by role id.
 *
 * The file is the ready-to-paste block for `roles.yaml`. It is also what
 * the tool reads when a project has not pasted the blocks into its roles
 * file yet, so the eight first-party roles answer for themselves in a
 * project that never touched the roles file.
 */

/** The scope blocks of the roles, keyed by role id. */
export type ScopeBlocks = Record<string, ScopeBlock>;

/** The name of the declarations file. */
export const SCOPE_DECLARATIONS_FILE = 'scope-declarations.yaml';

/**
 * Where the declarations file sits, in the order it is looked for.
 *
 * The first path is the package's own: the source tree and the built
 * package carry the file next to the module that reads it. The second is
 * the source tree of a checkout, for a build that did not copy the file.
 */
const SHIPPED_PATHS = [
  new URL(`../${SCOPE_DECLARATIONS_FILE}`, import.meta.url),
  new URL(`../../src/${SCOPE_DECLARATIONS_FILE}`, import.meta.url),
];

/**
 * Read the blocks out of the text of a declarations file.
 *
 * The file is a map of role id to block, and a block that does not hold
 * what a block has to hold fails the file: a declaration that is wrong is
 * not a declaration.
 */
export function parseScopeBlocks(text: string): ScopeBlocks {
  const raw: unknown = parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ScopeBlockError('scope declarations: expected a map of role id to declaration');
  }
  const blocks: ScopeBlocks = {};
  for (const [role, value] of Object.entries(raw)) {
    blocks[role] = parseScopeBlock(value, `scope declarations.${role}`);
  }
  return blocks;
}

/** Read the blocks of a declarations file. */
export async function loadScopeBlocks(path: string): Promise<ScopeBlocks> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ScopeBlockError(
      `cannot read the scope declarations at ${path}: ${(error as Error).message}`,
    );
  }
  return parseScopeBlocks(text);
}

/**
 * The blocks the package ships.
 *
 * The file is looked for in the package first and in the source tree
 * second. A package without the file has no declarations, and it says so
 * rather than returning an empty map that reads like a role with no scope.
 */
export async function loadShippedScopeBlocks(): Promise<ScopeBlocks> {
  const failures: string[] = [];
  for (const url of SHIPPED_PATHS) {
    try {
      return parseScopeBlocks(await readFile(url, 'utf8'));
    } catch (error) {
      failures.push(`${url.pathname}: ${(error as Error).message}`);
    }
  }
  throw new ScopeBlockError(
    `cannot find the scope declarations of the package:\n${failures.join('\n')}`,
  );
}

/** The block of a role, by its key, its agent id or the Lead agent name. */
export function scopeBlockForRole(blocks: ScopeBlocks, role: string): ScopeBlock | undefined {
  return blocks[scopeRoleKey(role)];
}

/** Where the block of a role came from. */
export type RoleScopeSource = 'roles.yaml' | 'the declarations file';

/**
 * A role and the block that says what it is for.
 *
 * The source is carried, because a block a person pasted into the roles
 * file and a block the package ships are not the same thing, and a reader
 * of the tool should know which one answered.
 */
export type RoleScope = {
  /** The role key, the key the roles file uses. */
  role: string;
  /** The name a person reads. */
  display: string;
  /** Where the block came from. */
  source: RoleScopeSource;
  /** The block itself. */
  declaration: ScopeBlock;
};

/**
 * The name a person reads for a role.
 *
 * The role key is the name: `lead` is the Lead.
 */
function displayName(role: string): string {
  if (role === '') return role;
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

/**
 * The block of one role.
 *
 * A block in the roles file wins over a block the package ships: the roles
 * file is the project's own file, and a project that changed the scope of a
 * role means it.
 */
export function roleScope(
  roles: RolesFile | undefined,
  blocks: ScopeBlocks | undefined,
  role: string,
): RoleScope | undefined {
  const key = scopeRoleKey(role);
  const fromRoles = roles?.roles[key]?.scopeBlock;
  if (fromRoles !== undefined) {
    return { role: key, display: displayName(key), source: 'roles.yaml', declaration: fromRoles };
  }
  const fromFile = blocks?.[key];
  if (fromFile !== undefined) {
    return {
      role: key,
      display: displayName(key),
      source: 'the declarations file',
      declaration: fromFile,
    };
  }
  return undefined;
}

/**
 * The block of one role, read through the roles loader.
 *
 * The roles file is read by the loader of the core, so a role is reached
 * by its key, by its agent id and by the Lead agent name, and a role with
 * no scope block has no declaration: the answer is undefined, and the
 * caller says so.
 */
export async function scopeDeclarationForRole(options: {
  role: string;
  rolesPath?: string | undefined;
  blocks?: ScopeBlocks | undefined;
}): Promise<RoleScope | undefined> {
  const roles = options.rolesPath === undefined ? undefined : await loadRoles(options.rolesPath);
  return roleScope(roles, options.blocks, options.role);
}
