# Changelog

Every release, from the commits that made it.

## 0.1.0 - 2026-10-23

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
