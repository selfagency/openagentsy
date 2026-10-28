import {
  isReviewed,
  listScopeDeclarations,
  REQUIRED_REVIEWERS,
  type ScopeDeclaration,
  scopeDeclaration,
} from '@openagentsy/core';

/**
 * The `oa scope` command (§22.3).
 *
 * It prints the scope declaration of one role, or of every role. It is a
 * command a person runs: the declarations are there to be read, and the
 * refusal a role makes is built from the same text.
 *
 * The command reads the declarations the core package ships. A project that
 * declares its own roles reads them from its own roles file, and that is a
 * follow-up: the roles file is a person's file and the parser that would
 * read a declaration out of it does not exist yet.
 */

/** What the command found. */
export type ScopeReport = {
  /** The role that was asked for, when one was named. */
  role: string | undefined;
  /** The declarations to print. */
  declarations: ScopeDeclaration[];
  /** The role that was asked for and is not there. */
  unknownRole: string | undefined;
};

/** The names of the roles, for a message that needs them. */
function roleNames(): string {
  return listScopeDeclarations()
    .map((declaration) => declaration.role)
    .join(', ');
}

/**
 * The declarations to print.
 *
 * With a role, the declaration of that role. Without one, every
 * declaration.
 */
export function runScope(role?: string | undefined): ScopeReport {
  if (role === undefined || role.trim() === '') {
    return {
      role: undefined,
      declarations: [...listScopeDeclarations()],
      unknownRole: undefined,
    };
  }
  const declaration = scopeDeclaration(role);
  if (declaration === undefined) {
    return { role: role.trim(), declarations: [], unknownRole: role.trim() };
  }
  return { role: declaration.role, declarations: [declaration], unknownRole: undefined };
}

/**
 * One declaration, as it is read.
 */
function formatDeclaration(declaration: ScopeDeclaration): string[] {
  const lines: string[] = [];
  lines.push(`${declaration.role} (${declaration.display}):`);
  lines.push(`  Purpose: ${declaration.purpose}`);
  lines.push('  In scope:');
  for (const entry of declaration.in_scope) lines.push(`    - ${entry.statement}`);
  lines.push('  Out of scope:');
  for (const entry of declaration.out_of_scope) lines.push(`    - ${entry.statement}`);
  lines.push(`  Refusal: ${declaration.refusal_pattern}`);
  lines.push(`  Redirect: ${declaration.redirect}`);
  lines.push(`  Review: ${formatReview(declaration)}`);
  return lines;
}

/**
 * Where the ethics review stands.
 *
 * A proposal says so: the declaration has not been through the maintainer
 * review of §17.5, and a person reading it should know that.
 */
function formatReview(declaration: ScopeDeclaration): string {
  if (isReviewed(declaration)) {
    return `reviewed by ${declaration.review.reviewers.join(', ')}`;
  }
  const signed = declaration.review.reviewers.length;
  return `proposed — ${signed} of ${REQUIRED_REVIEWERS} maintainers have reviewed it (§17.5)`;
}

/**
 * The declarations, as they are read.
 */
export function formatScope(report: ScopeReport): string {
  if (report.declarations.length === 0) {
    return [
      `no scope declaration for ${report.unknownRole ?? 'that role'}`,
      `the roles that have one: ${roleNames()}`,
      '',
    ].join('\n');
  }
  const lines: string[] = [];
  report.declarations.forEach((declaration, index) => {
    if (index > 0) lines.push('');
    lines.push(...formatDeclaration(declaration));
  });
  return `${lines.join('\n')}\n`;
}
