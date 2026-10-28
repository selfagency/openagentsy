/** @jsxImportSource @opentui/solid */

import { usePlugin } from '@opencode/plugin/tui';
import { For, Show } from 'solid-js';
import { fmtCount, fmtPlural } from '../format.js';
import { type CollapseStore, useCollapsed } from '../persist.js';
import type { BoardView } from '../readers.js';

/**
 * The board block.
 *
 * It says how much the board holds: the records the agents left, the leases
 * they hold and the caps the beans spend against. The numbers come from the
 * core package, which owns the board's tables.
 *
 * The framing rules hold it to two colours, the normal ones, and to copy
 * that does not blame anybody.
 */
export function BoardBlock(props: { view: BoardView; collapse: CollapseStore }) {
  const context = usePlugin();
  const [open, toggle] = useCollapsed(props.collapse, 'board');

  const base = () => context.theme.text.base;
  const muted = () => context.theme.text.muted;

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => void toggle()}>
        <text fg={base()}>{open() ? '▼' : '▶'}</text>
        <text fg={base()}>
          <b>Board</b>
        </text>
        <text fg={muted()}>
          {fmtPlural(props.view.records, 'record')} · {fmtPlural(props.view.leases.length, 'lease')}
        </text>
      </box>
      <Show when={open()}>
        <For each={props.view.leases}>
          {(lease) => (
            <text fg={muted()}>
              {lease.agent} holds {lease.glob} · {fmtCount(lease.minutes)} min
            </text>
          )}
        </For>
        <For each={props.view.budgets}>
          {(budget) => (
            <text fg={muted()}>
              {budget.bean} · {fmtCount(budget.tokensUsed)} of {fmtCount(budget.stopAt)} tokens
            </text>
          )}
        </For>
        <Show when={props.view.records === 0 && props.view.leases.length === 0}>
          <text fg={muted()}>nothing on the board yet</text>
        </Show>
      </Show>
    </box>
  );
}
