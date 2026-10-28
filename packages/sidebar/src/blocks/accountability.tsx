/** @jsxImportSource @opentui/solid */

import { usePlugin } from '@opencode/plugin/tui';
import { Show } from 'solid-js';
import { fmtCount, fmtPlural } from '../format.js';
import { type CollapseStore, useCollapsed } from '../persist.js';
import type { AccountabilityView } from '../readers.js';

/**
 * The accountability block.
 *
 * It says what is waiting for a person: the lessons that want a decision,
 * the memory candidates that want one, the waivers that were recorded, and
 * what the run produced. The counts come from the hooks, the memory package
 * and the ledger, and the three the plan names and the project does not
 * keep are not here, because nothing counts them.
 */
export function AccountabilityBlock(props: { view: AccountabilityView; collapse: CollapseStore }) {
  const context = usePlugin();
  const [open, toggle] = useCollapsed(props.collapse, 'accountability');

  const base = () => context.theme.text.base;
  const muted = () => context.theme.text.muted;

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => void toggle()}>
        <text fg={base()}>{open() ? '▼' : '▶'}</text>
        <text fg={base()}>
          <b>Accountability</b>
        </text>
        <text fg={muted()}>
          {fmtPlural(props.view.lessons, 'lesson')} ·{' '}
          {fmtPlural(props.view.memory, 'memory', 'memories')} ·{' '}
          {fmtPlural(props.view.waivers, 'waiver')}
        </text>
      </box>
      <Show when={open()}>
        <text fg={muted()}>
          {fmtCount(props.view.outcomes.tasksCompleted)} tasks completed ·{' '}
          {fmtCount(props.view.outcomes.commits)} commits ·{' '}
          {fmtCount(props.view.outcomes.prsMerged)} merged
        </text>
        <Show when={props.view.lessons === 0 && props.view.memory === 0}>
          <text fg={muted()}>nothing waiting for a decision</text>
        </Show>
      </Show>
    </box>
  );
}
