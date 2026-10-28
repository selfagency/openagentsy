# @openagentsy/offload

The local-model router for housekeeping jobs: a session title, a compaction
summary, a repaired tool argument, a classification, a quick reply. Work that
does not need the model that is doing the real work.

- **Local only.** The router talks to a local model server - Ollama, LM
  Studio, Apfel, Jan, LocalAI, vLLM - and to nothing else. Nothing here
  registers a plugin or writes a config.
- **Housekeeping only.** The five jobs are the ones in the plan (§9.1), and
  each one is the work whose answer can be wrong without mattering much.
- **It never throws.** An unreachable backend, a backend that answers with an
  error, an answer that does not fit the schema: the job comes back as
  `undefined` and the caller falls back to what it would have done anyway.
  There is one repair attempt and no retry loop.
- **Fail-closed on request.** In `required` mode the router takes the local
  backend or nothing, so a workspace that may not send a prompt off the
  machine never does.
- **The usage leaves through a callback.** `onUsage` reports the job, the
  seconds and the token counts. The ledger row is the caller's job.

`detectLocalBackends()` finds the servers that are running, with the models
they hold. With none, the list is empty and offloading is skipped: a local
model is an optimisation, never a dependency.
