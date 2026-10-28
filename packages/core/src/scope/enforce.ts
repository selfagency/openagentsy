import { join } from 'node:path';
import { appendAudit } from '../board/audit.js';
import { scopeDeclaration } from './declarations.js';
import type { ScopeDeclaration, ScopeEntry } from './types.js';

/**
 * The scope check (§22.2).
 *
 * A request that falls outside the declaration of the role that received it
 * is refused, the refusal names the declaration it came from, and the
 * refusal is written to the audit log.
 *
 * The sibling policy in the hooks package flags the drift of a reply; this
 * is the request-level half, and it is the half that cites the declaration
 * and leaves a row.
 */

/**
 * The policy id of the scope check.
 *
 * It is the id the plan gives the `oa.scope-enforcement` policy, and it is
 * the id the sibling policy in the hooks package uses. The `POLICIES` map
 * of the audit module does not carry it yet: that file was outside this
 * bean's file list, so the entry is proposed in the bean record instead.
 */
export const SCOPE_ENFORCEMENT_POLICY = { id: 'oa.scope-enforcement', version: 'v1' } as const;

/** What the check is asked about. */
export type ScopeRequest = {
  /** The role that received the request. */
  role: string;
  /** The request, as it was put. */
  request: string;
  /**
   * The declaration to use.
   *
   * A caller with its own declaration passes it, and the role is then only
   * a name in the verdict. Without one, the shipped declaration of the role
   * is used.
   */
  declaration?: ScopeDeclaration | undefined;
};

/** What the check decided. */
export type ScopeVerdict = {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** The role the request was addressed to. */
  role: string;
  /** The declaration that decided it, when the role has one. */
  declaration: ScopeDeclaration | undefined;
  /** The refusal, when the request was refused. */
  refusal: string | undefined;
  /** The out-of-scope entry that matched, when one did. */
  outOfScope: ScopeEntry | undefined;
  /** The in-scope entry that matched, when one did. */
  inScope: ScopeEntry | undefined;
  /** Whether the request matched neither list. */
  unclassified: boolean;
  /** Whether the refusal was written to the audit log. */
  audited: boolean;
  /** Why the audit did not happen, when it did not. */
  auditError: string | undefined;
};

/** The options of the check. */
export type ScopeEnforceOptions = {
  /** The state root, the directory that holds `.openagentsy`. */
  stateRoot: string;
  /** Who made the request. */
  actor?: string | undefined;
  /**
   * Refuse a request that matches neither list.
   *
   * Off by default: the plan blocks the requests that match an out-of-scope
   * pattern, and a caller that wants the boundary closed can ask for it.
   */
  denyUnclassified?: boolean | undefined;
  /** Where the audit line goes. The state root's, unless it is named here. */
  auditPath?: string | undefined;
};

/** The text a request is matched against. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Whether a request carries one of the entry's phrases.
 *
 * An entry with no phrase states a duty rather than a request to refuse,
 * and it never matches.
 */
function entryMatches(request: string, entry: ScopeEntry): boolean {
  const haystack = normalize(request);
  if (haystack === '') return false;
  return entry.match.some((phrase) => {
    const needle = normalize(phrase);
    return needle !== '' && haystack.includes(needle);
  });
}

/** The first entry that matches, if any. */
function firstMatch(request: string, entries: readonly ScopeEntry[]): ScopeEntry | undefined {
  return entries.find((entry) => entryMatches(request, entry));
}

/**
 * The refusal, as it is put to the requester.
 *
 * The pattern carries two placeholders: `[request]` is the request itself
 * and `[redirect]` is where the refused work goes. Both are filled in, so a
 * refusal always names the work that was asked for and the way to carry it
 * on.
 */
export function renderRefusal(
  declaration: ScopeDeclaration,
  request: string,
  entry?: ScopeEntry,
): string {
  const line = declaration.refusal_pattern
    .replace('[request]', () => request.trim())
    .replace('[redirect]', () => declaration.redirect);
  if (entry === undefined) return line;
  return `${line}\nDeclared out of scope: ${entry.statement}`;
}

/**
 * Decide whether a request is inside the declared scope.
 *
 * The check is pure: it reads the declaration and the request, and it
 * decides. Nothing is written, so a caller may ask what would happen
 * before it lets anything happen.
 *
 * A role with no declaration has nothing to enforce, and the request is
 * let through: the boundary of a role nobody declared is not something this
 * check can guess.
 */
export function classifyScope(request: ScopeRequest): ScopeVerdict {
  const declaration = request.declaration ?? scopeDeclaration(request.role);
  if (declaration === undefined) {
    return {
      allowed: true,
      role: request.role,
      declaration: undefined,
      refusal: undefined,
      outOfScope: undefined,
      inScope: undefined,
      unclassified: true,
      audited: false,
      auditError: undefined,
    };
  }

  const outOfScope = firstMatch(request.request, declaration.out_of_scope);
  if (outOfScope !== undefined) {
    return {
      allowed: false,
      role: request.role,
      declaration,
      refusal: renderRefusal(declaration, request.request, outOfScope),
      outOfScope,
      inScope: undefined,
      unclassified: false,
      audited: false,
      auditError: undefined,
    };
  }

  const inScope = firstMatch(request.request, declaration.in_scope);
  const unclassified = inScope === undefined;
  return {
    allowed: true,
    role: request.role,
    declaration,
    refusal: undefined,
    outOfScope: undefined,
    inScope,
    unclassified,
    audited: false,
    auditError: undefined,
  };
}

/**
 * Decide a request, and write the refusal down.
 *
 * The refusal is audited as the plan asks: a row with the policy id
 * `oa.scope-enforcement`, the action `block`, and the reason
 * `out-of-scope: <request>`.
 *
 * When the audit line cannot be written the refusal still stands. A
 * refusal that could not be recorded is still a refusal: the risk is the
 * out-of-scope work, and the missing row is reported rather than traded
 * against it.
 */
export async function enforceScope(
  request: ScopeRequest,
  options: ScopeEnforceOptions,
): Promise<ScopeVerdict> {
  const verdict = classifyScope(request);
  if (verdict.allowed) {
    if (!options.denyUnclassified || !verdict.unclassified) return verdict;
    // The caller closed the boundary: a request that matched neither list
    // is refused as well.
    const declaration = verdict.declaration;
    if (declaration === undefined) return verdict;
    const closed: ScopeVerdict = {
      ...verdict,
      allowed: false,
      refusal: renderRefusal(declaration, request.request, undefined),
    };
    return auditRefusal(closed, request.request, options);
  }
  return auditRefusal(verdict, request.request, options);
}

/**
 * Write the refusal to the audit log.
 *
 * The failure is reported and never swallowed: the caller sees that the
 * trail is incomplete.
 */
async function auditRefusal(
  verdict: ScopeVerdict,
  request: string,
  options: ScopeEnforceOptions,
): Promise<ScopeVerdict> {
  const path = options.auditPath ?? join(options.stateRoot, '.openagentsy', 'audit.jsonl');
  try {
    await appendAudit(path, {
      policyId: SCOPE_ENFORCEMENT_POLICY.id,
      policyVersion: SCOPE_ENFORCEMENT_POLICY.version,
      actor: options.actor ?? 'unknown',
      action: 'block',
      resource: verdict.role,
      effect: 'deny',
      detail: `out-of-scope: ${request}`,
    });
    return { ...verdict, audited: true };
  } catch (error) {
    return {
      ...verdict,
      audited: false,
      auditError: error instanceof Error ? error.message : String(error),
    };
  }
}
