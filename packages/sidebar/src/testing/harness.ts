import type { SessionMessageInfo } from '@opencode/client';
import type { Plugin } from '@opencode/plugin/tui';
import { type CapturedFrame, RGBA } from '@opentui/core';
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

/**
 * The colour of the error text.
 *
 * The framing rules ban it (§7.6): a block paints a measurement, and a
 * measurement in the error colour is a verdict the block has no business
 * making.
 */
export const ERROR = RGBA.fromHex('#ff5f5f');

/**
 * The colour of the warning text.
 *
 * The framing rules ban it too, and for the same reason.
 */
export const WARNING = RGBA.fromHex('#ffaf00');

/**
 * The colours the fake host paints with.
 *
 * A test that wants to see what a rule does when it is broken changes a
 * colour here, and the block paints with it.
 */
export interface FakeTheme {
  /** The colour of the normal text. */
  readonly base?: RGBA;
  /** The colour of the quiet text. */
  readonly muted?: RGBA;
  /** The colour of the error text. */
  readonly error?: RGBA;
  /** The colour of the warning text. */
  readonly warning?: RGBA;
}

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
  /** The colours the host paints with. */
  readonly theme?: FakeTheme;
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

  const colours = options.theme ?? {};
  const base = colours.base ?? BASE;
  const muted = colours.muted ?? MUTED;
  const error = colours.error ?? ERROR;
  const warning = colours.warning ?? WARNING;

  const theme = {
    text: {
      base,
      muted,
      faint: muted,
      feedback: {
        error: { base: error, muted: error },
        warning: { base: warning, muted: warning },
        success: { base, muted },
        info: { base, muted },
      },
    },
    background: {
      base: muted,
      feedback: {
        error: { base: error },
        warning: { base: warning },
        success: { base },
        info: { base },
      },
    },
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
  try {
    await setup.renderOnce();
    return setup.captureCharFrame();
  } finally {
    await setup.dispose();
  }
}

/**
 * A frame a tree draws, clicked at a point.
 *
 * The point is a column and a row of the frame, so a test clicks the line it
 * means to click.
 */
export async function clickFrame(
  tree: () => JSX.Element,
  at: { readonly x: number; readonly y: number },
  options: RenderOptions = {},
): Promise<void> {
  const { width, height } = { ...DEFAULT_RENDER, ...options };
  const setup = await testRender(tree, { width, height });
  try {
    await setup.renderOnce();
    await setup.mockMouse.click(at.x, at.y);
    await setup.flush();
  } finally {
    await setup.dispose();
  }
}

/**
 * The frame a tree draws, as spans.
 *
 * The spans carry the colours the frame was painted with, so a test can ask
 * what colour a line is without reading the theme (§7.6).
 */
export async function renderSpans(
  tree: () => JSX.Element,
  options: RenderOptions = {},
): Promise<CapturedFrame> {
  const { width, height } = { ...DEFAULT_RENDER, ...options };
  const setup = await testRender(tree, { width, height });
  try {
    await setup.renderOnce();
    return setup.captureSpans();
  } finally {
    await setup.dispose();
  }
}
