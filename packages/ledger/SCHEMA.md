# The ledger's schema

The ledger holds counters. This file says what they are, so a reader of the
export knows what every number means, and so a writer of a row knows what a
column is for.

## The tables

The database is `<state root>/.openagentsy/ledger.db` (SQLite, WAL mode, one
runtime: `bun:sqlite`).

| Table | What it holds |
| --- | --- |
| `usage` | One row per message: the token counts, the model, the role, the cost, the task and the timestamp. `message_id` is the primary key, so a replayed session does not change the totals. |
| `waste` | The waste signals of §6.4: a kind, the tokens it cost, and a detail. |
| `outcome` | What came of the work: a task completed or scrapped, a commit, a merged pull request. |
| `footprint` | The energy, water and carbon of a message, as bounds, with the method that produced them. |
| `policy_firing` | Every policy evaluation, with its action and the reason (REV3 §21.3). Written by the policy module. |
| `safety_metric` | The per-session safety metrics (REV3 §18.2). |

## The two contracts

**The role arrives resolved.** `usage.role` holds the role key the adapter
resolved: `lead`, `scout`, `researcher`, `builder`, `reviewer`, `advisor`,
`archivist` or `offload`. The ledger never resolves a role and never infers
one; it stores what it is given. `usage.role_raw` holds the unresolved agent
id of a backfilled row, and a row with a `role_raw` is left out of every
per-role report, because it cannot be attributed rather than mis-attributed.

**An unpriced model is empty, never zero.** `usage.cost_reported` is the cost
the host reported, and `usage.cost_estimated` is the price the chain found.
Both are `NULL` when nothing is known. A `NULL` cost means "unpriced", and a
report must show it as such: a zero would be a claim that the work was free.

## The token count

A message's tokens are `input + output + reasoning + cache_write`. The tokens
read from the cache are left out, because they were paid for when they were
written, and counting them twice would make every number too large.

## The export

`oa ledger export --json` writes this shape:

```json
{
  "schema": "openagentsy.ledger/v1",
  "generatedAt": "2026-10-26T12:00:00.000Z",
  "totals": {
    "messages": 3,
    "tokens": 200,
    "input": 130,
    "output": 55,
    "reasoning": 10,
    "cacheRead": 900,
    "cacheWrite": 5,
    "usd": 0.5,
    "unpricedMessages": 2
  },
  "byRole": [{ "role": "builder", "messages": 1, "tokens": 155, "usd": 0.5, "unpriced": 0 }],
  "byTask": [{ "taskId": "oa-2b-1", "messages": 2, "tokens": 170, "usd": 0.5 }],
  "waste": { "tokens": 20, "percentage": 10 },
  "outcomes": { "tasksCompleted": 1, "tasksScrapped": 0, "commits": 0, "prsMerged": 0 },
  "tokensPerCompletedTask": 170,
  "offload": { "messages": 1, "tokens": 30, "usd": null }
}
```

There is no message id, no session id and no commit sha in the export: the
counters are grouped by a role and by a task, and nothing else. A cost of
`null` means unpriced, and `unpricedMessages` counts the messages that carry
no price at all.

## The pricing chain

The price of a message is the first of these that knows it:

1. the cost the host reported on the message;
2. models.dev, at `cost.{input,output,cache_read,cache_write}` per million tokens;
3. LiteLLM's pricing file;
4. OpenRouter's models endpoint;
5. nothing, which is an unpriced model.

Every source is cached for a day under `~/.cache/openagentsy/pricing/`, and a
copy is bundled in `data/pricing/` for an offline machine. A source that
raises its rate above a token threshold prices the whole request at the
higher rate, which is what the providers do.

## The footprint rows

A footprint row holds the bounds of the energy, the water and the carbon of
one message, and the version of the methodology that produced them
(`ecologits-0.11.3`). The ledger stores an impact it is given; it does not
compute one.
