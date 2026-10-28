import {
  alwaysFalse,
  hasApi,
  hasHook,
  hasPermissionKey,
  hasPluginBundle,
  hasTuiEntry,
  type ProjectFiles,
  probeBackends,
} from './probe.js';

/**
 * The capability registry (§11).
 *
 * A capability is one surface of the host that the project depends on. Each
 * one is reported separately, and each one carries the state it is in:
 *
 * - `proven_static`: the files and the config are there, the plugin loads
 *   and its schema validates;
 * - `observed`: it was seen working in a real session, and the evidence is
 *   in `.openagentsy/conformance.json`;
 * - `unverified`: neither.
 *
 * The host is OpenCode 2. The project spoke OpenCode 1 as well until
 * 2026-10-27, and every V1 entry of the plan's sketch is void: there is no
 * second runtime to report on. The voided entries are kept in
 * `VOIDED_CAPABILITIES` with the reason, so the report says what was
 * dropped and not only what is left.
 */

/** The host a capability belongs to. */
export type ConformanceHost = 'v2';

/** The state a capability is in. */
export type ConformanceState = 'proven_static' | 'observed' | 'unverified';

/**
 * One surface of the host.
 *
 * `verifyRef` is the anchor of the plan section the capability settles, so a
 * VERIFY in the plan and a capability in the registry are two ends of one
 * rope.
 */
export type Capability = {
  /** The name the capability is known by. */
  id: string;
  /** The host the capability belongs to. */
  host: ConformanceHost;
  /** The section of the plan this capability settles, when it settles one. */
  verifyRef?: string | undefined;
  /** What the capability is, in one line. */
  title: string;
  /** Whether the project's own files show the surface is there. */
  probeStatic: (files: ProjectFiles) => boolean;
  /** The event that would witness the capability working. */
  observeOn: readonly string[];
};

/**
 * The capabilities of the host, one per surface the project depends on.
 *
 * The order is the order of the plan: the ledger, the sidebar, the bridge,
 * the rules and the router.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'message-token-fields',
    host: 'v2',
    verifyRef: '§6.2',
    title: 'The token and cost fields of an assistant message',
    probeStatic: hasApi('tokens.cache'),
    observeOn: ['message.updated'],
  },
  {
    id: 'opencode-db-schema',
    host: 'v2',
    verifyRef: '§6.2',
    title: 'The table schema of the OpenCode database',
    probeStatic: alwaysFalse,
    observeOn: ['oa.backfill.schema'],
  },
  {
    id: 'sidebar-slot',
    host: 'v2',
    verifyRef: '§7.1',
    title: 'The sidebar content slot of the TUI plugin',
    probeStatic: hasTuiEntry,
    observeOn: ['ui.slot.render'],
  },
  {
    id: 'panel-registration',
    host: 'v2',
    verifyRef: '§7.1',
    title: 'The panel of the TUI plugin',
    probeStatic: hasTuiEntry,
    observeOn: ['ui.panel.open'],
  },
  {
    id: 'session-family',
    host: 'v2',
    verifyRef: '§7.2',
    title: 'The session family of a session',
    probeStatic: hasApi('data.session.family'),
    observeOn: ['session.family.read'],
  },
  {
    id: 'prompt-insert',
    host: 'v2',
    verifyRef: '§7.4',
    title: 'Inserting a command into the prompt',
    probeStatic: alwaysFalse,
    observeOn: ['prompt.inserted'],
  },
  {
    id: 'memory-inbox-keymap',
    host: 'v2',
    verifyRef: '§7.4',
    title: 'The keymap layer of the TUI plugin',
    probeStatic: alwaysFalse,
    observeOn: ['keymap.layer.memory'],
  },
  {
    id: 'tui-storage-kv',
    host: 'v2',
    verifyRef: '§7.5',
    title: 'The durable store of the TUI plugin',
    probeStatic: hasApi('storage.store'),
    observeOn: ['storage.store'],
  },
  {
    id: 'plugin-context-envelope',
    host: 'v2',
    verifyRef: '§8.2',
    title: 'The envelope of an event the plugin is handed',
    probeStatic: hasApi('event.data'),
    observeOn: ['oa.plugin.context'],
  },
  {
    id: 'permission-hook-agent',
    host: 'v2',
    verifyRef: '§8.2',
    title: 'The agent in the permission event',
    probeStatic: hasHook('permission', 'evaluate'),
    observeOn: ['permission.asked'],
  },
  {
    id: 'v2-permission-key',
    host: 'v2',
    verifyRef: '§8.2',
    title: 'The permission key of the shell',
    probeStatic: hasPermissionKey('shell'),
    observeOn: ['permission.asked'],
  },
  {
    id: 'turn-end-events',
    host: 'v2',
    verifyRef: '§8.2',
    title: 'The events that say a turn is over',
    probeStatic: alwaysFalse,
    observeOn: ['session.execution.succeeded', 'session.execution.failed'],
  },
  {
    id: 'session-list-directory',
    host: 'v2',
    verifyRef: '§8.2',
    title: 'The directory the session list is filtered by',
    probeStatic: alwaysFalse,
    observeOn: ['session.listed'],
  },
  {
    id: 'interrupt-resume-false',
    host: 'v2',
    verifyRef: '§8.2',
    title: 'The interrupt that does not resume the session',
    probeStatic: alwaysFalse,
    observeOn: ['session.interrupted'],
  },
  {
    id: 'tool-hook-args',
    host: 'v2',
    verifyRef: '§8.2',
    title: 'The arguments of a tool call, and the power to stop it',
    probeStatic: hasHook('tool', 'execute.before'),
    observeOn: ['oa.tool.before'],
  },
  {
    id: 'plugin-loaded',
    host: 'v2',
    verifyRef: '§8.2',
    title: 'The plugin, loaded by the host as a plugin',
    probeStatic: hasPluginBundle,
    observeOn: ['oa.plugin.loaded'],
  },
  {
    id: 'shell-env-hook',
    host: 'v2',
    verifyRef: '§8.3',
    title: 'The environment of the shell of an agent',
    probeStatic: hasHook('shell', 'create.before'),
    observeOn: ['oa.shell.env'],
  },
  {
    id: 'local-offload',
    host: 'v2',
    verifyRef: '§9.2',
    title: 'The local model that does the housekeeping',
    probeStatic: probeBackends,
    observeOn: ['offload.completed'],
  },
];

/**
 * A capability of the plan's sketch that the project does not have.
 *
 * The reason is what makes the entry a record and not a deletion: the
 * capability is void because the runtime it described is gone, not because
 * the work was forgotten.
 */
export type VoidedCapability = {
  /** The name the plan gave the capability. */
  id: string;
  /** The host it belonged to. */
  host: 'v1';
  /** Why the capability is void. */
  reason: string;
};

/**
 * The V1 capabilities of the plan's sketch, and why they are void.
 *
 * The project speaks OpenCode 2 only since 2026-10-27 (decision of
 * 2026-10-27, landed in `316f758` and `79672b2`). Every entry below names a
 * surface of the OpenCode 1 host, and there is no OpenCode 1 host to report
 * on. The V2 route of the same need, where there is one, is a capability of
 * its own in `CAPABILITIES`.
 */
export const VOIDED_CAPABILITIES: readonly VoidedCapability[] = [
  {
    id: 'v1-toast',
    host: 'v1',
    reason: '§7.7 is void: there is no V1 runtime, so there is no toast to fire on session.idle.',
  },
  {
    id: 'system-transform',
    host: 'v1',
    reason:
      'The experimental.chat.system.transform hook is an OpenCode 1 hook; the 2.x context has no such hook.',
  },
  {
    id: 'compaction-hook',
    host: 'v1',
    reason:
      'The experimental.session.compacting hook is an OpenCode 1 hook, and the 2.x surface probe found no compaction hook, so the write contract has no host to settle it.',
  },
  {
    id: 'tool-before-block',
    host: 'v1',
    reason:
      'The tool.execute.before hook is an OpenCode 1 hook; the 2.x path blocks a write in the permission hook instead.',
  },
  {
    id: 'plugin-loaded',
    host: 'v1',
    reason:
      'The V1 route was the app.log call of the plugin; the 2.x plugin registers through setup only, so the V2 route is its own capability.',
  },
  {
    id: 'args-mutate-in-place',
    host: 'v1',
    reason:
      'The in-place rewrite of the arguments is an OpenCode 1 fact; the 2.x tool hook carries the arguments the tool runs with.',
  },
  {
    id: 'permission-config-merge',
    host: 'v1',
    reason:
      'The 2.x context has no config domain, so the host permission map cannot be written from a plugin; the approval is asked through the permission hook.',
  },
  {
    id: 'permission-ask-hook',
    host: 'v1',
    reason:
      'The permission.ask hook is an OpenCode 1 hook that nothing in 1.19.4 called; the 2.x route is the permission hook.',
  },
  {
    id: 'text-complete-hook',
    host: 'v1',
    reason:
      'The experimental.text.complete hook is an OpenCode 1 hook; the 2.x route is the session.text.ended event.',
  },
  {
    id: 'shell-env-hook',
    host: 'v1',
    reason:
      'The shell.env hook is an OpenCode 1 hook; the 2.x route is the create.before hook of the shell domain.',
  },
  {
    id: 'mcp-tool-prefix',
    host: 'v1',
    reason:
      'The tool.execute.before hook does not fire for an MCP call on the OpenCode 1 host; on 2.x the permission hook is the enforcement, so there is no prefix to observe.',
  },
];

/** The capability with that name, when the registry has one. */
export function capabilityById(id: string): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.id === id);
}

/** The sections of the plan the registry settles. */
export function verifyRefs(): readonly string[] {
  const refs: string[] = [];
  for (const capability of CAPABILITIES) {
    const ref = capability.verifyRef;
    if (ref === undefined) continue;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}
