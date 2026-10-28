/** @jsxImportSource @opentui/solid */

import { usePlugin } from '@opencode/plugin/tui';
import { For, Show } from 'solid-js';
import { fmtCount, fmtPlural, fmtUsd } from '../format.js';
import { type CollapseStore, useCollapsed } from '../persist.js';
import type { BudgetView } from '../readers.js';

/**
 * The budget block.
 *
 * It says what the run cost: the tokens, the price, the tokens of each
 * resolved role, the waste, the tokens one completed task cost and the
 * offloaded work. The numbers are the ledger's own export, and the caps are
 * the board's own check, so the block and the `oa ledger` command answer the
 * same question the same way.
 */
export function BudgetBlock(props: { view: BudgetView; collapse: CollapseStore }) {
  const context = usePlugin();
  const [open, toggle] = useCollapsed(props.collapse, 'budget');

  const base = () => context.theme.text.base;
  const muted = () => context.theme.text.muted;

  const roles = () => props.view.byRole.slice(0, 3);

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => void toggle()}>
        <text fg={base()}>{open() ? '▼' : '▶'}</text>
        <text fg={base()}>
          <b>Budget</b>
        </text>
        <text fg={muted()}>
          {fmtCount(props.view.totals.tokens)} tokens · {fmtUsd(props.view.totals.usd)}
        </text>
      </box>
      <Show when={open()}>
        <For each={roles()}>
          {(role) => (
            <text fg={muted()}>
              {role.role} · {fmtCount(role.tokens)} tokens
            </text>
          )}
        </For>
        <text fg={muted()}>
          waste · {fmtCount(props.view.waste.tokens)} tokens (
          {props.view.waste.percentage.toFixed(1)}%)
        </text>
        <text fg={muted()}>
          per task ·{' '}
          {props.view.tokensPerTask === null
            ? 'no completed task'
            : `${fmtCount(props.view.tokensPerTask)} tokens`}
        </text>
        <text fg={muted()}>
          offload · {fmtPlural(props.view.offload.messages, 'message')} ·{' '}
          {fmtCount(props.view.offload.tokens)} tokens
        </text>
        <For each={props.view.caps}>
          {(cap) => (
            <text fg={muted()}>
              {cap.bean} · {fmtCount(cap.tokensUsed)} of {fmtCount(cap.stopAt)} tokens
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}
