import type { SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import { RGBA } from '@opentui/core';
import { testRender } from '@opentui/solid';
import type { JSX } from 'solid-js';
import { createStore, produce, type Store } from 'solid-js/store';

/**
 * The test harness.
 *
 * Every block in this package is rendered from a fixture, in the renderer
 * OpenTUI ships, and the frame it draws is read back: the text for what the
 * block says, the spans for the colours it painted with. The harness holds
 * the part that is the same for all of them, so a block's test holds only
 * the fixture that is its own.
 */

/** The colour of the normal text. */
const BASE = RGBA.fromHex('#e6e6e6');

/** The colour of the quiet text. */
const MUTED = RGBA.fromHex('#8a8a8a');

/** The factory of a keymap layer, as the host types it. */
export type LayerFactory = Parameters<Plugin.Context['keymap']['layer']>[0];

/** A keymap layer, as the host types it. */
export type KeymapLayer = ReturnType<LayerFactory>;

/** What the harness records about the host a block talked to. */
export interface Host {
  /** The context the block sees. */
  readonly context: Plugin.Context;
  /** The panels the block opened, in order. */
  readonly panels: string[];
  /** The layers the block registered, in order. */
  readonly layers: KeymapLayer[];
}

/** What the harness lets a test set up. */
export interface HostOptions {
  /** The messages the session holds. */
  readonly messages?: readonly SessionMessageInfo[];
  /** The sessions the family holds. */
  readonly family?: readonly string[];
  /** The session the block is about. */
  readonly sessionID?: string;
}

/**
 * The host, as far as a block can tell.
 *
 * The context is a fake with the parts a block uses and nothing else: the
 * session's messages, the theme, the panel, the storage and the keymap. The
 * panel and the keymap are recorded, so a test can see that a block opened
 * the method panel or registered the memory keys.
 */
export function fakeHost(options: HostOptions = {}): Host {
  const messages = options.messages ?? [];
  const family = options.family ?? ['ses_fixture'];
  const panels: string[] = [];
  const layers: KeymapLayer[] = [];
  const stores = new Map<string, unknown>();
  const memories = new Map<string, unknown>();

  const data = {
    session: {
      family: () => [...family],
      message: {
        list: () => [...messages],
        sync: async () => undefined,
      },
    },
  };

  const theme = {
    text: { base: BASE, muted: MUTED, faint: MUTED },
  };

  const ui = {
    panel: {
      open: (name: string) => {
        panels.push(name);
        return true;
      },
      close: () => undefined,
      current: () => undefined,
    },
    slot: () => () => undefined,
  };

  const keymap = {
    layer: (factory: LayerFactory) => {
      layers.push(factory());
    },
    dispatch: () => undefined,
    shortcuts: () => [],
    commands: () => [],
    pending: () => [],
    active: () => [],
    mode: { current: () => 'base', push: () => () => undefined },
  };

  const storage = {
    store: <Value extends object>(key: string, opts: { readonly initial: Value }) => {
      let entry = stores.get(key) as
        | { store: Store<Value>; set: (mutation: (draft: Value) => void) => void }
        | undefined;
      if (!entry) {
        const [store, setStore] = createStore<Value>(structuredClone(opts.initial));
        entry = {
          store,
          set: (mutation) => setStore(produce(mutation)),
        };
        stores.set(key, entry);
      }
      const { store, set } = entry;
      return [store, async (mutation: (draft: Value) => void) => set(mutation)] as const;
    },
    memory: <Value extends object>(key: string, opts: { readonly initial: Value }) => {
      let entry = memories.get(key) as
        | { store: Store<Value>; set: (mutation: (draft: Value) => void) => void }
        | undefined;
      if (!entry) {
        const [store, setStore] = createStore<Value>(structuredClone(opts.initial));
        entry = {
          store,
          set: (mutation) => setStore(produce(mutation)),
        };
        memories.set(key, entry);
      }
      const { store, set } = entry;
      return [store, (mutation: (draft: Value) => void) => set(mutation)] as const;
    },
  };

  const context = { data, theme, ui, keymap, storage } as unknown as Plugin.Context;
  return { context, panels, layers };
}

/** How a frame is rendered. */
export interface RenderOptions {
  /** The width of the frame, in columns. */
  readonly width?: number;
  /** The height of the frame, in rows. */
  readonly height?: number;
}

/** The default frame: wide enough for a block, tall enough for its lines. */
const DEFAULT_RENDER: Required<RenderOptions> = { width: 72, height: 32 };

/**
 * The frame a tree draws, as text.
 *
 * The text is what a person reads, so a test that asserts on it is asserting
 * on the block's copy and not on the structure that made it.
 */
export async function renderFrame(
  tree: () => JSX.Element,
  options: RenderOptions = {},
): Promise<string> {
  const { width, height } = { ...DEFAULT_RENDER, ...options };
  const setup = await testRender(tree, { width, height });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  await setup.dispose();
  return frame;
}
