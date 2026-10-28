/** @jsxImportSource @opentui/solid */

import { usePlugin } from '@opencode/plugin/tui';
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { FootprintConfig } from '../config.js';
import { fmtCo2, fmtL, fmtSci, fmtWh } from '../format.js';
import { estimateImpact } from '../impact.js';
import { PANEL_NAME } from '../panel.js';
import { useFamilyUsage } from '../usage.js';

/**
 * The footprint block.
 *
 * It says what the session cost the grid: the energy, the water, the carbon
 * and the warming, each as a range. The framing rules hold it to two
 * colours, the normal ones, and to copy that does not blame anybody.
 */

/** What each source of uncertainty widens. */
const UNCERTAINTY: Record<string, string> = {
  'model-size': 'the size of the model',
  site: 'the site of the data centre',
  grid: 'the grid',
  tcre: 'the climate sensitivity',
};

export function FootprintBlock(props: { sessionID: string; config: FootprintConfig }) {
  const context = usePlugin();
  const rows = useFamilyUsage(() => props.sessionID);
  const estimate = createMemo(() => estimateImpact(rows(), props.config));
  const [open, setOpen] = createSignal(true);

  const base = () => context.theme.text.base;
  const muted = () => context.theme.text.muted;

  const undisclosed = createMemo(() =>
    rows().some((row) => props.config.site(row.providerID)?.disclosed === false),
  );

  return (
    <Show when={estimate().estimated > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen(!open())}>
          <text fg={base()}>{open() ? '▼' : '▶'}</text>
          <text fg={base()}>
            <b>Footprint</b>
          </text>
          <text fg={muted()}>
            {fmtWh(estimate().impact.energyWh)} · {fmtL(estimate().impact.waterL)} ·{' '}
            {fmtCo2(estimate().impact.co2Kg)}
          </text>
        </box>
        <Show when={open()}>
          <text fg={muted()}>Electricity {fmtWh(estimate().impact.energyWh)}</text>
          <text fg={muted()}>Water {fmtL(estimate().impact.waterL)} data centre and grid</text>
          <text fg={muted()}>
            Carbon {fmtCo2(estimate().impact.co2Kg)} {props.config.region}
          </text>
          <Show when={props.config.showWarming}>
            <text fg={muted()}>Warming {fmtSci(estimate().impact.warmingC)} °C IPCC TCRE</text>
          </Show>
          <text fg={muted()}>
            the range comes mostly from{' '}
            {UNCERTAINTY[estimate().impact.dominantUncertainty] ?? 'the size of the model'}
          </text>
          <For each={estimate().impact.notes}>{(note) => <text fg={muted()}>· {note}</text>}</For>
          <Show when={undisclosed()}>
            <text fg={muted()}>· the infrastructure is undisclosed for some providers</text>
          </Show>
          <Show when={estimate().skipped > 0}>
            <text fg={muted()}>
              · {estimate().skipped} model(s) left out: no site or no throughput configured
            </text>
          </Show>
          <text fg={muted()} onMouseDown={() => context.ui.panel.open(PANEL_NAME)}>
            method and sources ›
          </text>
        </Show>
      </box>
    </Show>
  );
}
