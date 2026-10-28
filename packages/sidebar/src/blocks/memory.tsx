/** @jsxImportSource @opentui/solid */

import { usePlugin } from '@opencode/plugin/tui';
import { For, Show } from 'solid-js';
import { fmtPlural } from '../format.js';
import { type CollapseStore, useCollapsed } from '../persist.js';
import type { MemoryView } from '../readers.js';

/**
 * The memory inbox block.
 *
 * It lists the candidates no person has decided on. The candidates are the
 * board's pending `bean: memory` records - the queue the archivist actually
 * fills - and the memory package owns what a pending record is and what a
 * candidate carries.
 */
export function MemoryInboxBlock(props: { view: MemoryView; collapse: CollapseStore }) {
  const context = usePlugin();
  const [open, toggle] = useCollapsed(props.collapse, 'memory');

  const base = () => context.theme.text.base;
  const muted = () => context.theme.text.muted;

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => void toggle()}>
        <text fg={base()}>{open() ? '▼' : '▶'}</text>
        <text fg={base()}>
          <b>Memory inbox</b>
        </text>
        <text fg={muted()}>{fmtPlural(props.view.candidates.length, 'candidate')}</text>
      </box>
      <Show when={open()}>
        <For each={props.view.candidates}>
          {(candidate) => (
            <text fg={muted()}>
              {candidate.id} · {candidate.category} · {candidate.text}
            </text>
          )}
        </For>
        <Show when={props.view.candidates.length === 0}>
          <text fg={muted()}>no candidate waiting</text>
        </Show>
      </Show>
    </box>
  );
}
