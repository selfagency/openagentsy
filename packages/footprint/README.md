# @openagentsy/footprint

The energy, water and carbon of one inference, as ranges.

Every quantity this package produces is an interval, because the inputs are:
a model size nobody discloses, a data centre's PUE, a grid's carbon factor.
A point estimate would hide that, so the type makes the width impossible to
lose.

The formulas are re-implemented from the EcoLogits LLM inference
methodology (CC BY-SA 4.0, https://github.com/mlco2/ecologits). The EcoLogits
data is not bundled here: its license is unverified, so the model map and the
grid factors are injected by the caller.

```ts
import { estimateRemote } from '@openagentsy/footprint';

const impact = estimateRemote(usage, arch, site, throughput);
impact.energyWh; // [lo, hi] in Wh
impact.co2Kg; // [lo, hi] in kgCO2
```

The prefill term is an OpenAgentsy extension and it is off by default: its
coefficients are fitted in a later phase and are not shipped.

The golden data in `data/golden.json` was computed with the EcoLogits
library, offline, by `scripts/golden.py`.
