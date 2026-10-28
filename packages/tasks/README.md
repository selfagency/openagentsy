# @openagentsy/tasks

The task store: Beans-compatible task files, the `oa_task_*` tools and the
short prime block.

A task is a Markdown file with YAML front matter, kept in `.beans/` and
committed with the code. The format is the one hmans/beans writes, byte for
byte, so the files a person already has can be read and written by both.

- `TaskStore` reads and writes the files: a stat-keyed cache so the prime
  block does not reparse the tree on every message, atomic writes, and an
  etag for optimistic concurrency.
- `oa_task_list`, `oa_task_show`, `oa_task_create`, `oa_task_update`,
  `oa_task_next` and `oa_task_archive` are the tools.
- `primeBlock` is the state summary a session gets on every message: the
  open, the in-progress and the ready tasks, in under two hundred tokens.
- The rules live in the code, not in a prompt: which status a task may move
  to, what a completed task has to say, and which dependency is refused.

```ts
import { OpenAgentsyTasks, primeBlock, TaskStore } from '@openagentsy/tasks';
```

Licensed under GPL-3.0-or-later. The fractional order keys are a port of
hmans/beans (Apache-2.0), and the test corpus is copied from it; see the
NOTICE file at the root of the repository.
