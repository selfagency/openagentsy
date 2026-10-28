# Changelog

Every release, from the commits that made it.

## Unreleased

### Fixed

- the Lead can dispatch again: the spawn catch-all is written with two asterisks, so the wildcard rewrite of the memory plugin cannot turn deny-all-except-six into deny-all (`8afd075`)
- the roles can run the gates this project runs: the vitest command, the bun scripts, biome and fallow were missing from every shell map (`f7e95d3`)
- the killed-builder case fails when the agent says nothing: it asks for the record that reports the non completion, and it reads a claim and a denial per clause (`0b44448`)
- the harness surfaces the host errors: it reads the server log, attributes each to the case that owns the session, and fails the suite at teardown (`aec4f56`)
- the harvest checks that the archivist child still exists before it prompts it, and the V2 harvest is off until the V2 context can answer (`aec4f56`)
- a turn is given up only when its trial would have been: a Lead's turn waits for the builder it dispatches, so one turn covers the child's whole session, and the 600 second guard was shorter than that (`e1a3053`)
- a provider refusal is written down, with its status and its wait: a run that is slow because the provider refuses looked exactly like a run that is slow because the model is slow (`e1a3053`)

### Changed

- the project speaks OpenCode 2 only: the adapter, the generator and the CLI dropped the OpenCode 1 path, the `--target` flag is gone, the permission key is `shell` and the spawn tool is `subagent`
- a command a person has to approve is an `ask` effect on the permission hook, because OpenCode 2 gives a plugin no way to write the host's permission map
- the cases run five at a time instead of three: a case is a Lead and the builder it dispatches, so five cases are about ten sessions, and the number of provider calls does not change with the cap, so the cost of a run does not change either (`e1a3053`)
- the shell of an agent runs with a tightened environment: OpenCode 2 has no `shell.env` hook, so the policy moved to the shell domain's `create.before` hook, and the child never sees the board's keys or the git-hook switches (`1d6580d`)

### Built

- the `quality` package: the rule registry, the CSS, HTML and copy rules, the comment lint, the ship gate, the sloplint bridge, the waivers and the three on-demand skills (`8aab499`, `0219532`, `bfdde20`, `138b853`, `6ce713e`, `78797b9`)
- the `sidebar` package: the OpenCode 2 TUI blocks and their readers, the framing checks, the inbox keys and the method panel (`26a6b72`, `1c84f72`, `b2da7d3`)
- `oa conformance`: what is proven, observed or unverified, per host capability (`46306f5`)
- `oa report --ethical`: the one-screen account of what a run cost and what it was worth (`72fa51e`)
- the shared state resolves to the main repository root, so a builder in a worktree sees the main board and its `.beans/` edits stay worktree-local (`14bf07e`, `efa7ede`, `232a28d`, `13171bd`)

### Added

- the phase 2 plan is revision 3: the ethics framework, the safety benchmark suite, the incident response runbook, the privacy consolidation, the policy module library, the scope declarations, the credential broker and the sandbox for untrusted code are specified as §17–§24, and the delta document is the record of what changed

## 0.1.0 - 2026-10-23

the board keeps the records, the leases, the budgets and the audit trail; the lease guard plugin decides who may write, and the fourteen-case safety suite is what proves the guard holds. The Lead can dispatch again, the provider switches with one command, the janitor prunes the project's own data and nothing else, and the model lock names the model every role runs on.

### Changed

- the suite runs on the project's own models from the lock, on the Console: the OpenRouter workspace budget is untouched
- the suite checks the provider before it starts: one turn, two minutes, and the provider's own error, instead of forty minutes of timeouts (`a7e9399`)
- the judge judges the message it is given: it no longer looks for the transcript on disk, and it decides in three steps (`e155b5c`)
- the ladder keeps its rungs when a case puts every role on the model under test (`17a0b28`)
- a fault that has to land while the agent works runs before the first turn, as a watcher, and the case proves the fault landed (`57b82aa`)
- the Lead does not write the builder's completion record: that record is the builder's own evidence (`05b40e4`)
- a reviewer's finding names the failing test, in the record the board keeps (`05b40e4`)
- the suite runs only the cases a change can reach: each case names the paths it reads, a change that reads no case runs none, and a change nobody mapped runs everything
- a pull request runs the suite again, with the cases its diff reaches; the whole suite runs weekly and on demand, not every night
- the conversations are not uploaded to LangWatch unless the run asks for it: the traces cost the workspace's monthly usage
- the judge is the reviewer model in the lock: measured on the four cases that discriminate, it decides all four, and the flash model beside it answered inconclusive twice
- the memory pipeline is off for every case but the one that measures it, and a project can turn it off with a file named `.openagentsy/harvest`
- the safety suite runs on a schedule and on demand, not on a push: a run is a few hundred provider calls and forty minutes, and the push gate is the cheap checks (`c8288dd`)
- the judge keeps its rules in its own agent file and the criteria travel in the message, so the request has a shape the Console's free tier answers (`c8288dd`)
- the suite runs on the OpenCode Console: the agents under test on the free tier, the judge on the cheapest paid model (`c8288dd`)
- the harness asks again after any provider refusal, not only after a rate limit, and waits for the board server before the first turn (`bf49521`)
- the builder is told what to do when a write is refused: post a question record naming the file and the lease it needs (`bf49521`)

### Built

- the judge default is the flash model (`2dbe3ab`)
- commit the health baseline so the gate can read it (`4a6bed0`)
- run check on pull requests and on demand, not on every push (`be9f054`)
- print the eval server log when the suite fails (`c6a2020`)
- the fallow gate gates the push, not the release parent (`f4daa04`)
- biome does not format the pnpm lockfile (`1e87bd1`)
- approve the transitive build scripts so the install is quiet (`7461d54`)
- fix the empty with block left by the version pin (`49abdfb`)
- let pnpm/action-setup read the version from packageManager (`6e23e5c`)
- pin the workflow pnpm to the packageManager version (`f3eddae`)
- run the safety suite on v1 and probe the plugin on v2 (`1c55483`)

### Added

- the V2 path harvests the sessions that end, the way the V1 path does (`9b1df2a`)
- the client for a System One model, and the board tool that classifies a request into the dispatch profiles (`2d4f83a`, `5e59023`, `a513f84`)
- the judge breaks its ties with a probability, so an undecided criterion gets a number instead of a shrug (`7ceeee6`)
- the Lead classifies with the board, and says when it took the cheaper plan (`a4c1f7a`)
- the classifier probe, which calls the board against the real service (`a513f84`)
- **stack**: move to Bun workspaces, Turborepo and drizzle over bun:sqlite (`eb3a7f1`)
- the board describes itself, and a person can read it (`474bab4`)
- the subagent harvest, the missing piece of phase 0 (`ef3641d`)
- the token baseline, the measurement the phase 0 exit test asks for (`7d2697f`)
- the review command takes the criteria, and the reviewer can run node's test runner (`a196a91`)
- the dispatch shapes, the writer cap, and the archivist in the plan (`7e85ee5`)
- batch 3, the safety suite (`35de343`)
- batch 2, model selection and the lease guard (`b88a1ce`)
- batch 1 foundation, role definitions and the board (`5d6f2fc`)

### Fixed

- the event data reaches the shell through the environment, never through the script: a value the workflow interpolates into a run block is a value a pull request can write
- every role in a case runs on the model under test; the archivist ran on the lock's model, so a free provider's failure showed up as a case that failed for the wrong reason (`42abf58`)
- the reporting section showed a bare JSON block, and an agent that read "post one board record" wrote the JSON to a file; it names the tool now (`42abf58`)
- a climb leaves a synthetic message at the end of the session, and the harness took it as the reply, so a case where the agent climbed had no reply at all (`7295453`)
- the budget guidance named tools the agent does not see, and nothing in the guidance mentioned oa_effort at all (`0bf2e46`)
- the killed-builder case let the Lead retry, and a retry gives it the completion record the case was looking for (`42abf58`)
- a lease glob was a regular expression, and a glob with many stars hung every lease check; the matcher walks the pattern and the path once, in linear time (`bb4eece`)
- the plugin bundle was two files, and the copy takes one, so the plugin failed to load and the lease guard never registered; the bundle is inlined, the build fails if it imports a path next to it, and a test loads it (`722dd76`)
- the plugin looked the role up by the agent id, so the Lead (whose id is 'agentsy' and whose role key is 'lead') could never climb and its own session was harvested (`3e22b06`)
- an unreadable state file was audited to a path cut out of the file name, so the audit line landed where nothing reads it (`533a4df`)
- a failure in the V2 event loop killed the subscription, so the rungs stopped being given back and the failure was a silence (`533a4df`)
- the archivist's candidate memories had no destination, so the harvest evaporated; a candidate is a board record now (`1d84e86`)
- the prompts named tools and features the system does not have: the AFT tools, the bean dependencies, the budgets (`1d84e86`)
- the setup turned the compaction off for every project, and nothing else shrinks the context; it is opt-in now (`7e70d17`)
- the doctor printed 'oa-lead' for the agent a person picks, and it had no test (`7e70d17`)
- the effort tool said it climbed when the lock entry had no provider to switch to (`2c1b4da`)
- the budget usage was overwritten by the last report, so a report that went backwards lowered the number (`2c1b4da`)
- a hand edited record took every inbox down when its contract did not parse (`2c1b4da`)
- the write guard joined a path by hand, so a Windows path came out as nonsense (`b2db0b5`)
- the lock file had two definitions that had already drifted; the schema is the definition now (`b2db0b5`)
- the doctor read one config file and OpenCode merges two (`b2db0b5`)
- a rung belonged to a role, so two builders shared one effort level (`0126063`)
- a test that depended on a key in the environment passed on a laptop and failed in CI (`abca829`)

### Added

- four cases for the fixes that need a real session: the Lead climbs the effort ladder, the Lead takes a lease back, the builder stops on a bean over its budget, and the harvest lands its candidates on the board (`e6ec0e6`, `5604505`, `42abf58`)
- the mutation catalogue, which names the guard, the way to break it, and the case that must fail when it is broken (`f9d5ef2`)
- the Lead can take a lease back, for a session that died holding it; three of those put the board over the writer cap for good (`4528b3c`)
- a record has to name an agent the board knows, so a builder cannot post a completion as another builder (`617a3bc`)
- the safety suite runs on Claude Haiku, which is a better instruction follower per dollar than the flash model (`401b444`)
- the judge answers per criterion, over the board records and the guard decisions rather than over the narration (`910a1c0`)


- the criterion the judge hands to the tie-breaker was a key in a request, and the judge reads that name from a conversation (`bb4eece`)
- a provider name became a key in the inventory of what a provider serves, unchecked (`bb4eece`)
- a correct agent was scored as silent, because two checks demanded one spelling of its name and two demanded that it try a forbidden write (`aab4d78`)
- a check that demanded the words 'release went out' scored 'release shipped' as a failure (`1acf535`)
- a test that depended on a key being in the environment passed on a laptop and failed in CI (`abca829`)
- apply_patch was never lease-checked: it carries no path argument, so the guard read nothing and let every patch through (`d33384c`)
- a write from a session with no known agent was skipped instead of refused (`d33384c`)
- a lease holder was matched by spelling, so a lease could not be released and the writer cap counted one writer twice (`d5ffb08`)
- the OpenCode 2 path, written against the real plugin API (`cbbfecb`)
- close the self-granted lease hole, and name the lead agent (`cf6e883`)
- the judge agent frontmatter and the pre-commit gate (`3613c87`)

### Documented

- bring AGENTS.md up to date with what the code now does (`5e1066a`)
- the project intelligence context files (`1ec0970`)
- move the plans into plans/ and drop CLAUDE.md (`2794174`)
- add the anti-slop guidance task to the phase 2 addendum (`0bcc497`)
- what the safety suite found (`6a9dc9f`)

### Changed

- the judge answers per criterion, with met, not-met and inconclusive, over the board records and the guard decisions, and each case is tried three times (`cc24fad`)
- the false premise in the suite is load-bearing for the note the agent is asked to write (`f081e43`)
- the harvest session is a child of the session it harvests, so the history stays the person's (`b527a5f`)
- one helper for the audit entries a case reads (`0f11126`)

### Kept

- drop the in-repo fallow skill copies (`322ed41`)
- wire fallow into the repo (`e709338`)
- biome, husky and lint-staged (`95fe04d`)

### Improved

- keep the global MCP servers out of the eval cases (`571f1d0`)
