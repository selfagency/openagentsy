/**
 * The approval of a command, on the V2 path.
 *
 * The V1 path writes the commands a person has to approve into OpenCode's
 * own permission map, and OpenCode asks the person with its normal prompt.
 * The V2 path has no map to write: the plugin context has no `config`
 * domain, so there is no hook that hands the host a permission block
 * (measured on a live OpenCode 2.2.0 server, 2026-10-27).
 *
 * The V2-native way is the permission hook. The hook sees the decision
 * before it is made and it carries the effect, so the plugin sets the
 * effect to `ask` and OpenCode asks the person itself. The mechanism is
 * different from the V1 one — a map the plugin writes against a hook the
 * plugin answers — and only the V2 one is live once V1 goes.
 *
 * The command is the resource of a `shell` action. A permission event for a
 * shell call carries the command itself, so the pattern is matched against
 * the command the person would read.
 */

/** The permission action of the shell tool on V2. */
export const SHELL_ACTION = 'shell';

/**
 * The characters of a pattern that mean something to a regular expression.
 */
function escapeFor(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a command matches a pattern.
 *
 * The pattern is the command and a trailing asterisk, and the asterisk
 * matches any run of characters. That is the spelling the V1 permission map
 * used, so a project that names the same command asks about the same
 * commands on either path.
 */
function matches(pattern: string, command: string): boolean {
  const parts = pattern.split('*').map(escapeFor);
  return new RegExp(`^${parts.join('.*')}$`).test(command);
}

/**
 * The approval a command asks for, when it asks for one.
 *
 * The command of the project is the prefix of the command that runs, so
 * `git push` asks about `git push --force` as well. The command that matched
 * is returned, so the message names what a person is asked about.
 */
export function commandApproval(
  command: string,
  approvalFor: readonly string[],
): string | undefined {
  for (const entry of approvalFor) {
    const wanted = entry.trim();
    if (wanted === '') continue;
    if (matches(`${wanted}*`, command)) return wanted;
  }
  return undefined;
}

/**
 * The event of a permission decision, as the V2 context hands it over.
 *
 * The shape is the one the V2 path uses, narrowed to the two fields this
 * module reads.
 */
export type ApprovalEvent = {
  /** What the action is: `shell` for the shell tool. */
  action: string;
  /** The things the action touches. A shell action names the command. */
  resources: readonly string[];
  /** The effect the decision carries. */
  effect: 'allow' | 'ask' | 'deny';
  /** The message the person reads. */
  message?: string | undefined;
};

/**
 * Ask a person about a command, when the project says a person must.
 *
 * The effect only ever tightens: a decision that is already `deny` stays
 * `deny`, and a command that nobody asked about is left alone. A plugin may
 * not loosen what the host decided, and the same rule the V1 merge held
 * holds here.
 */
export function applyApproval(event: ApprovalEvent, approvalFor: readonly string[]): boolean {
  if (event.action !== SHELL_ACTION) return false;
  if (event.effect === 'deny') return false;
  for (const resource of event.resources) {
    const wanted = commandApproval(resource, approvalFor);
    if (wanted === undefined) continue;
    event.effect = 'ask';
    event.message = `OpenAgentsy asks a person about this command: ${wanted}.`;
    return true;
  }
  return false;
}
