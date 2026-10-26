# @openagentsy/ledger

The usage ledger: tokens, cost, waste, outcomes and footprint, per message.

**Numbers only.** The ledger stores token counts, model ids, timestamps, task
ids and commit shas. It never stores a prompt, a completion or a line of
code: the transcripts stay in OpenCode's own storage, and nothing here is
uploaded anywhere. A report can say what the work cost without ever holding
the work.

The role of a message arrives **already resolved** by the adapter. The ledger
stores the role it is given and never resolves one, so a report cannot
mis-attribute a message to a role it was not given.

```sh
oa ledger export --json   # the counters, and only the counters
oa ledger --root .        # the same numbers, for a human
```

The shape of the export is in [SCHEMA.md](./SCHEMA.md), and the tables are
described there too.
