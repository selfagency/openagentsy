/** @jsxImportSource @opentui/solid */
import { usePlugin } from '@opencode/plugin/tui';

/**
 * The method panel of the footprint block.
 *
 * It says where the numbers come from and what they do not cover, because a
 * range without its method is a number nobody can argue with.
 */
export function MethodPanel() {
  const context = usePlugin();
  const muted = () => context.theme.text.muted;
  const base = () => context.theme.text.base;

  return (
    <box flexDirection="column">
      <text fg={base()}>How this is estimated</text>
      <text fg={muted()}>
        The energy, water and carbon follow the EcoLogits methodology: a regression of the energy
        one output token costs, the number of GPUs the model needs, and the power usage
        effectiveness of the data centre.
      </text>
      <text fg={muted()}>
        Every number is a range, because the model size, the site, the grid and the climate
        sensitivity are all ranges. The widest of them is named under the block.
      </text>
      <text fg={muted()}>
        The energy covers the output tokens only, the way EcoLogits measures it. The prefill term is
        an OpenAgentsy extension and is off unless a project turns it on.
      </text>
      <text fg={muted()}>
        The EcoLogits methodology is published under CC BY-SA 4.0, and the credit is in the NOTICE
        file of the project.
      </text>
    </box>
  );
}
