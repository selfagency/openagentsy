# The sources behind the numbers

## EcoLogits

The formulas in `src/estimate.ts` are re-implemented from the EcoLogits LLM
inference methodology (CC BY-SA 4.0), https://github.com/mlco2/ecologits.
The credit is in the repository `NOTICE` and in the README.

**The EcoLogits data is not bundled here.** Its `models.json` carries a
license this project has not verified, so the model map, the provider sites
and the grid factors are injected by the caller (`Registry` in
`src/resolve.ts`). Only computed results are committed: `golden.json` holds
twenty estimated outcomes, not EcoLogits data files.

## The pinned release

`data/golden.json` was generated with EcoLogits **0.11.3** by
`scripts/golden.py`, which refuses to run against any other release. The
numbers it writes are the ones the test in `src/golden.test.ts` compares
against, within 1 percent.

## The provider table

The provider defaults in `src/resolve.ts` were checked against EcoLogits
0.11.3:

| Provider key | PUE | WUE on-site (L/kWh) |
| --- | --- | --- |
| `anthropic` | 1.09-1.14 | 0.13-0.999 |
| `google` (EcoLogits: `google_genai`) | 1.09 | 0.999 |
| `mistral` (EcoLogits: `mistralai`) | 1.16 | 0.09 |
| `openai` | 1.20 | 0.569 |
| any other provider | 1.09-1.14 | 0.13-0.999, marked `disclosed: false` |

The constants in `src/constants.ts` are the rounded values the plan quotes.
EcoLogits 0.11.3 uses `1.1665273170451914e-06`, `-0.011205921025579175` and
`4.052928146734005e-05`; the rounding moves the per-token energy by 0.05
percent, well inside the 1 percent the golden test allows.

## The prefill term

No prefill coefficients ship. The fit belongs to a later phase, and it does
not go in until a person has reviewed it.
