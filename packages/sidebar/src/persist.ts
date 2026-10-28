import type { Plugin } from '@opencode/plugin/tui';
import { createMemo } from 'solid-js';
import type { Store } from 'solid-js/store';

/**
 * The collapse state of the blocks (§7.5).
 *
 * A block that is collapsed shows its headline and nothing else, and the
 * person decides that once and keeps it: the state lives in the host's
 * durable store, so it survives a restart and is the same in every window.
 *
 * The store is a prop and not something the block reaches for, because the
 * block is then testable without a host, and because the host owns the key
 * the state is filed under.
 */

/** The state of the collapsed blocks. */
export interface CollapseState {
  /** The keys of the blocks that are collapsed. */
  collapsed: string[];
}

/** The key the collapse state is filed under in the host's store. */
const COLLAPSE_KEY = 'openagentsy.sidebar.collapse';

/** The state a project starts with: nothing collapsed. */
const INITIAL_COLLAPSE: CollapseState = { collapsed: [] };

/** The writer of the collapse state. */
export type CollapseWriter = (mutation: (draft: CollapseState) => void) => Promise<void>;

/**
 * The collapse store: the durable state, and the writer that goes with it.
 *
 * The two travel together because the state is read-only from the outside:
 * the host hands out a store to read and a function to write, and a block
 * that holds only the store could not collapse anything.
 */
export interface CollapseStore {
  /** The durable state. */
  readonly state: Store<CollapseState>;
  /** The writer the host gave with the store. */
  readonly set: CollapseWriter;
}

/**
 * The collapse store of the host.
 *
 * The host's storage is durable and live-synced, so the state is the same
 * in every window and survives a restart.
 */
export function collapseStore(context: Plugin.Context): CollapseStore {
  const [state, set] = context.storage.store<CollapseState>(COLLAPSE_KEY, {
    initial: INITIAL_COLLAPSE,
  });
  return { state, set };
}

/**
 * Whether a block is open, and the function that toggles it.
 *
 * The reading is a memo over the store, so a write to the store re-renders
 * the block that reads it.
 */
export function useCollapsed(
  store: CollapseStore,
  key: string,
): readonly [() => boolean, () => Promise<void>] {
  const keys = () => store.state.collapsed;
  const open = createMemo(() => !keys().includes(key));
  const toggle = async (): Promise<void> => {
    const next = open()
      ? [...keys().filter((entry) => entry !== key), key]
      : keys().filter((entry) => entry !== key);
    await store.set((draft) => {
      draft.collapsed = next;
    });
  };
  return [open, toggle] as const;
}
