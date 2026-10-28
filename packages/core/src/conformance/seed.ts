import type { Observation } from './evidence.js';

/**
 * The seeded evidence.
 *
 * The project measured the surface of OpenCode 2 on a live server and wrote
 * the measurement on the board. This is that record, in the shape the
 * evidence store reads, and every observation names where it came from: the
 * board record, the probe script that took it, or the published declaration
 * it was read from.
 *
 * The seed lives in the package and not in the state file, for two reasons.
 * The first is that the state root of a worktree is the main repository, so
 * a builder in a worktree would write into the Lead's state; the second is
 * that a seed that travels with the code is a seed every checkout can
 * reproduce.
 *
 * The `kind` is the difference that matters. A `live` observation was seen
 * working on a live OpenCode server. A `schema` observation was read off
 * the published type declarations of the host, which is a reading of a
 * package and not a session. Only the first puts a capability in the
 * `observed` state.
 */

/** The declarations the schema observations were read from. */
const DECLARATIONS = {
  kind: 'declaration',
  ref: '@opencode/plugin@2.2.0 dist/tui/context.d.ts',
  date: '2026-10-28',
} as const;

/** The seeded observations, one per measured fact. */
export const SEED_OBSERVATIONS: readonly Observation[] = [
  {
    capabilityId: 'permission-hook-agent',
    eventType: 'permission.asked',
    at: '2026-10-27T23:35:20.660Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '688', date: '2026-10-27' },
    note: 'the raw permission event of a live 2.1.3 server carried agent build, action edit, resources leased/ok.txt and effect allow',
  },
  {
    capabilityId: 'v2-permission-key',
    eventType: 'permission.asked',
    at: '2026-10-27T23:35:20.660Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '688', date: '2026-10-27' },
    note: 'the third permission event of the turn carried action shell, so the v2 shell key is shell and not bash',
  },
  {
    capabilityId: 'v2-permission-key',
    eventType: 'permission.shell',
    at: '2026-10-27T23:30:15.276Z',
    kind: 'live',
    source: {
      kind: 'probe-script',
      ref: 'packages/adapter-opencode/scripts/probe-v2-facts.mjs',
      date: '2026-10-27',
    },
    note: 'the 2.1.3 binary holds the tool plugin id opencode.tool.shell and no opencode.tool.bash, and no permission bash string exists in it',
  },
  {
    capabilityId: 'turn-end-events',
    eventType: 'session.execution.succeeded',
    at: '2026-10-27T23:35:20.660Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '688', date: '2026-10-27' },
    note: 'the plugin subscription saw session.execution.started and then session.execution.succeeded, and 2.1.3 sends the same names as 2.2.0',
  },
  {
    capabilityId: 'plugin-context-envelope',
    eventType: 'oa.plugin.context',
    at: '2026-10-27T22:58:13.309Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '682', date: '2026-10-27' },
    note: 'the plugin context yields the raw envelope with data and no properties, and the stream carried the session.execution names and no idle event',
  },
  {
    capabilityId: 'session-list-directory',
    eventType: 'session.listed',
    at: '2026-10-27T22:58:13.309Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '682', date: '2026-10-27' },
    note: 'GET /api/session answered an empty list for directory and every session for location[directory], so the route honours directory and ignores the other spelling',
  },
  {
    capabilityId: 'interrupt-resume-false',
    eventType: 'session.interrupted',
    at: '2026-10-27T22:58:13.309Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '682', date: '2026-10-27' },
    note: 'the interrupt route carries a resume parameter; resume=false answers interrupted=true and the outcome stays interrupted on a later read',
  },
  {
    capabilityId: 'shell-env-hook',
    eventType: 'oa.shell.env',
    at: '2026-10-28T00:23:04.279Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '693', date: '2026-10-28' },
    note: 'the create.before hook of the shell domain carried the environment of the child, and the child ran without the keys that belong to the board',
  },
  {
    capabilityId: 'message-token-fields',
    eventType: 'message.updated',
    at: '2026-10-27T23:35:20.660Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '688', date: '2026-10-27' },
    note: 'the assistant message carried tokens input 3423, output 47, reasoning 0, cache read 19121, write 0, and a cost',
  },
  {
    capabilityId: 'tool-hook-args',
    eventType: 'oa.tool.before',
    at: '2026-10-27T23:51:26.261Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '690', date: '2026-10-27' },
    note: 'the v2 tool hook fired with the v1 hook names, and the live run allowed a leased write and refused an unleased path',
  },
  {
    capabilityId: 'plugin-loaded',
    eventType: 'oa.plugin.loaded',
    at: '2026-10-28T00:23:04.279Z',
    kind: 'live',
    source: { kind: 'board-record', ref: '693', date: '2026-10-28' },
    note: 'the real bundle was loaded as the plugin by a live OpenCode 2.2.0 server, and the plugin registered through setup',
  },
  {
    capabilityId: 'session-family',
    eventType: 'session.family.read',
    at: '2026-10-28T04:51:23.320Z',
    kind: 'schema',
    source: DECLARATIONS,
    note: 'ctx.data.session.family(sessionID) returns a string array of ids and not session objects; measured in board record 706 against the 2.2.0 and 2.1.3 declarations, which are byte-identical',
  },
  {
    capabilityId: 'sidebar-slot',
    eventType: 'ui.slot.render',
    at: '2026-10-28T04:51:23.320Z',
    kind: 'schema',
    source: DECLARATIONS,
    note: 'context.ui.slot is a function that takes a claim and returns an unsubscribe, and the claim carries one placement key and a render function; board record 706',
  },
  {
    capabilityId: 'panel-registration',
    eventType: 'ui.panel.open',
    at: '2026-10-28T04:51:23.320Z',
    kind: 'schema',
    source: DECLARATIONS,
    note: 'context.ui.panel has no register: it is open, close and current, and the panel content is contributed through the session.panel slot; board record 706',
  },
  {
    capabilityId: 'tui-storage-kv',
    eventType: 'storage.store',
    at: '2026-10-28T04:51:23.320Z',
    kind: 'schema',
    source: DECLARATIONS,
    note: 'ctx.storage.store(key, {initial}) is the durable disk-persisted JSON store, and the sidebar keeps its collapse state in it; board records 706 and 708',
  },
  {
    capabilityId: 'memory-inbox-keymap',
    eventType: 'keymap.layer.memory',
    at: '2026-10-28T04:51:23.320Z',
    kind: 'schema',
    source: DECLARATIONS,
    note: 'ctx.keymap.layer(factory) exists in the declarations, so the memory inbox can take its keys from the host; board record 706',
  },
];
