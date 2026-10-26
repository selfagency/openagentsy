# @openagentsy/memory

The consumer side of the memory pipeline: the decision, the store, and the
way back in. The producer side is the archivist, which posts candidate
memories as board records.

`MemoryStore` is an append-only `memory.jsonl` at the state root
(`.openagentsy/memory.jsonl`), one JSON object per line. `MemoryInbox` is
the board's pending `bean: memory` records, and the decision on them.
`createMemoryTools` defines `oa_memory_search`, `oa_memory_list` and
`oa_memory_decide`.

- **Redaction runs first.** `redact()` from `@openagentsy/core` runs over the
  text before an entry can be appended, and the count comes back with it.
- **Dedup on append.** The normalized text is hashed with `etagOf`, and a
  duplicate is refused with the id of the entry that already holds it.
- **The decision is human-only.** `roles.yaml` denies `oa_memory_decide` and
  `openagentsy_memory_decide` to every role: the tool exists and works, and
  the map is what stops an agent from calling it.
- **No auto-injection.** Nothing here touches a prompt. A memory is found by
  asking for it.
- **Unverified memories are redacted in a search** until a person marks
  them verified, and approving a candidate is not verifying it.

## The known limitation

The generic-assign redaction pattern in `@openagentsy/core` needs more than
four bits of entropy per character, so a pure-hex secret is never flagged by
that pattern. The other six patterns still cover their own shapes. This is
the plan's own §8.4 specification, and it is a 2f review candidate.

## Licence

GPL-3.0-or-later.
