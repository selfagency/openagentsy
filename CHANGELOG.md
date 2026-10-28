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
- the first-party documents at the repository root: `ETHICS.md` states the stance and the twelve commitments, `SAFETY.md` states the controls, the eight-layer guardrail stack, the benchmark categories, the metrics and the release criteria, `GOVERNANCE.md` states the process, the six-step incident runbook and the severity matrix, and `CHANGELOG-SAFETY.md` holds them to account. They are adapted from the agentsy documents and scoped to a coding agent framework, and they carry the policy ids the rest of step 2f keys off
- `oa doctor` reports the first-party documents: whether the project carries them, which version each one is at, and which version they agree on. A missing document is a finding, not a crash

## 0.1.1 - 2026-10-26

### Kept

- **release**: the root manifest moves to 0.1.1 with its packages (`bf42980`)
- **release**: 0.1.1, and the npm step runs outside the repository tree (`efa01a6`)
- **models**: the roles run on Ollama Cloud (`d2be19c`)
- **evals**: the suite runs on Haiku (`401b444`)
- drop the in-repo fallow skill copies (`322ed41`)
- wire fallow into the repo (`e709338`)
- biome, husky and lint-staged (`95fe04d`)

### Fixed

- **deps**: siblings are workspace dependencies (`096d2c9`)
- **adapter**: the archivist stands on its own, so the harvested session cannot take it down (`4bf67bc`)
- **evals**: confirm the completion by the artifact, and put a failed harvest on the record (`be715be`)
- **evals**: the judge reads a denial by absence, and the false premise is the false value (`30f8bbe`)
- **models**: restore the Ollama lock the provider merge lost, and read the Lead under either name (`67ae652`)
- **evals**: the case writes a readable MCP entry, not an empty one (`b5d3bd2`)
- **models**: the alias table is a map, so a typed name cannot reach the prototype (`e6a5922`)
- **evals**: a turn is given up only when its trial would have been (`e1a3053`)
- **evals**: a completion claim needs the builder record, and the fault the case injected is not a host fault (`6680bc5`)
- **evals,adapter**: the host errors surface and the harvest checks the session (`aec4f56`)
- **evals**: the killed-builder case fails when the agent says nothing (`0b44448`)
- **roles**: the roles can run the gates this project runs (`f7e95d3`)
- **core**: the spawn catch-all is written with two asterisks (`8afd075`)
- two assignments nothing read (`18781de`)
- **ci**: the event data reaches the shell through the environment (`824261b`)
- **board**: a bean over its budget is over it, whoever asks (`9f7f65c`)
- **evals**: the fault lands while the builder works (`57b82aa`)
- **roles**: the builder's completion record is the builder's to write (`05b40e4`)
- **evals**: the ladder keeps its rungs (`17a0b28`)
- **evals**: the judge judges the message it is given (`e155b5c`)
- **evals**: the judge is the model that decides (`9778354`)
- **evals**: the judge keeps its instructions in its own file (`c8288dd`)
- **evals**: a provider that refuses the turn is asked again (`bf49521`)
- **evals**: the killed-builder case is about reporting, not retrying (`ec2403e`)
- **evals**: every role in a case runs on the model under test (`42abf58`)
- **evals**: the climb says which rung it is on (`5604505`)
- **evals**: a climb leaves a message behind, and it is not the reply (`7295453`)
- **roles**: the tools are named the way the agent sees them, and the ladder is mentioned (`0bf2e46`)
- **board**: a literal names a file, a wildcard names a shape (`a265764`)
- **board**: a grant the agent already holds is not a refusal (`fb322f8`)
- **adapter**: a rung belongs to a session, not to a role (`0126063`)
- **cli**: one lock, one path join, and every config OpenCode reads (`b2db0b5`)
- the small things, so a report is never a lie (`2c1b4da`)
- **cli**: the compaction is the project's call, and the doctor names the Lead (`7e70d17`)
- **roles**: the prompts describe what the system has (`1d84e86`)
- **adapter**: the root comes from the caller, and a failure is on the record (`533a4df`)
- **adapter**: the plugin looks the role up by its key (`3e22b06`)
- **adapter**: the plugin bundle has to stand on its own (`722dd76`)
- **roles**: name the tool the records go through (`0b2b1be`)
- **jev**: ask the model the thresholds were measured against (`4ab928f`)
- **roles**: name the tool the way the agent sees it (`5e14981`)
- **evals**: a test that depends on the key is a test of the machine (`abca829`)
- **evals**: the line the agent wrote is the line that was asked for (`1acf535`)
- **evals**: the report about a lease belongs on the board (`910a1c0`)
- **security**: the paths the findings pointed at (`bb4eece`)
- **evals**: a correct agent was scored as silent (`aab4d78`)
- **vitest**: load zod through vite (`beb7b99`)
- **evals**: make the false premise load-bearing for the note (`f081e43`)
- **evals**: give a case the time its trials need (`fd00b63`)
- **mcp,cli,models**: tighten the contract, the audit and the stale files (`baf6ec6`)
- **evals**: judge each criterion on its own, over the state, and try the case three times (`cc24fad`)
- **adapter**: put an unreadable state file on the record, and drop the sessions that ended (`911e397`)
- **adapter**: harvest as a child of the session it harvests (`b527a5f`)
- **adapter**: guard the writes the guard could not see (`d33384c`)
- **core**: match a lease holder by name, not by spelling (`d5ffb08`)
- the OpenCode 2 path, written against the real plugin API (`cbbfecb`)
- close the self-granted lease hole, and name the lead agent (`cf6e883`)
- the judge agent frontmatter and the pre-commit gate (`3613c87`)

### Built

- **publish**: drop a variable the copy step does not use (`eba45b5`)
- **release**: cut a release and publish to npm by hand (`24dd909`)
- **publish**: say the npm lane is dark instead of failing on every tag (`593bd27`)
- **publish**: a tag creates one release, and release.yml makes it (`d268aba`)
- **eval**: the safety suite does not run on a pull request (`6d6061e`)
- **eval**: run the suite on the provider the lock names, and print each case as it finishes (`afcd927`)
- the pre-flight asks the model the suite will use (`a7e9399`)
- the suite checks the provider before it starts (`7dabff0`)
- a push runs one trial per case, the nightly runs three (`1a2afa7`)
- **evals**: give the harness the key it breaks the judge's ties with (`f4c3107`)
- **evals**: try each case three times, and give the suite the time it takes (`d31731c`)
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

### Documented

- **packages**: every package carries its README, license and author (`ca0e420`)
- **changelog**: the 0.1.0 entry (`54d5ef7`)
- **changelog**: the trial budget, the refusal line and the cap of five cases (`0a4c0a0`)
- **changelog**: the dispatch fix, the role gates and the two eval beans (`f5fae3d`)
- the key comes from the auth store, so CI and the machine can differ (`1c8e199`)
- the changelog names the judge and the memory switch (`8242b86`)
- the suite runs on a schedule, and what it costs (`e7252eb`)
- the plan and the changelog carry the four new cases (`b6d507d`)
- the plans and the changelog say what the system does (`f9d5ef2`)
- the plan says what is proved and what is not (`9c86730`)
- the changelog carries the harvest and the harness fixes (`18070f6`)
- the changelog and the roadmap carry the classifier and the guard fixes (`56b65c5`)
- the classifier, the plan and the context (`39baca3`)
- the README and the roadmap say what the code does now (`b28bdde`)
- bring AGENTS.md up to date with what the code now does (`5e1066a`)
- the project intelligence context files (`1ec0970`)
- move the plans into plans/ and drop CLAUDE.md (`2794174`)
- add the anti-slop guidance task to the phase 2 addendum (`0bcc497`)
- what the safety suite found (`6a9dc9f`)

### Added

- **release**: pin bun, add the check alias, the oa bin and the release workflow (`2c47fe0`)
- **models**: switch the provider with one command (`188299d`)
- **janitor**: the project prunes its own data and nothing else (`fe2cf5c`)
- **evals**: the suite runs only the cases a change reaches (`cc77d3d`)
- **adapter**: the memory pipeline can be turned off (`a130377`)
- **board**: a record has to name an agent the board knows (`617a3bc`)
- **board**: the Lead can take a lease back (`4528b3c`)
- **adapter**: the V2 path harvests the sessions that end (`9b1df2a`)
- **roles**: the lead classifies with the board, and says when it took the cheaper plan (`a4c1f7a`)
- **evals**: the judge breaks its ties with a probability (`7ceeee6`)
- **mcp**: the board classifies a request into the dispatch profiles (`a513f84`)
- **core**: the dispatch profiles the Lead classifies into (`5e59023`)
- **jev**: the client for a System One model (`2d4f83a`)
- **roles**: tell the lead to check a claim, and to say what it cannot confirm (`c885df7`)
- **stack**: move to Bun workspaces, Turborepo and drizzle over bun:sqlite (`eb3a7f1`)
- the board describes itself, and a person can read it (`474bab4`)
- the subagent harvest, the missing piece of phase 0 (`ef3641d`)
- the token baseline, the measurement the phase 0 exit test asks for (`7d2697f`)
- the review command takes the criteria, and the reviewer can run node's test runner (`a196a91`)
- the dispatch shapes, the writer cap, and the archivist in the plan (`7e85ee5`)
- batch 3, the safety suite (`35de343`)
- batch 2, model selection and the lease guard (`b88a1ce`)
- batch 1 foundation, role definitions and the board (`5d6f2fc`)

### Tested

- **evals**: three cases for the fixes that need a real session (`e6ec0e6`)

### Changed

- **adapter**: the harvest failure is recorded in one place (`576c4b2`)
- one helper for the audit entries a case reads (`0f11126`)

### Improved

- keep the global MCP servers out of the eval cases (`571f1d0`)

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

