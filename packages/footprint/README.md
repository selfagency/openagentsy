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

The prefill term is an OpenAgentsy extension and it is off by default. Its
coefficients are fitted from ML.ENERGY measurements and committed in
`data/prefill-fit.json`, but they do not ship enabled: `footprint.prefill`
stays false, and a caller who wants the term passes the coefficients in.

```ts
const impact = estimateRemote(usage, arch, site, throughput, {
  prefill: { kIn: [7.19e-7, 7.19e-7], kCache: [7.19e-8, 7.19e-8] },
});
```

The golden data in `data/golden.json` was computed with the EcoLogits
library, offline, by `scripts/golden.py`.
