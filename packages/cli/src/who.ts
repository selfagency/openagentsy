/**
 * Who the person running a command is.
 *
 * A decision a person makes carries the name of the person who made it. The
 * name comes from the environment when it is set, because a person may want
 * the record to say who they are, and the default is "a person".
 */
export function deciderBy(override?: string): string {
  return override ?? process.env.OPENAGENTSY_USER ?? 'human';
}
