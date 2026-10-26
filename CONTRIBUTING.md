# Contributing

## What you need

- Bun. The version is pinned in `package.json` (`packageManager`) and in `.bun-version`.
- Git.
- 1Password, or another signing path: this repository signs its commits.

## The command that checks the code

```bash
bun run check
```

That is Biome and the typecheck, and it is the body of `bun run ci:check` too; the unit
tests are their own command, `bun run test`, and they build first.

## Branches

Work lands on a topic branch and merges into `develop` (`git flow feature start <name>`),
on the gitflow-next classic preset, where `main` is the release parent.

## The changelog

`CHANGELOG.md` holds the convention: every release, from the commits that made it. Read
the file before you add an entry, and follow the shape it already uses.

## The safety suite

The safety suite does not run in CI on a pull request: a run is a few hundred provider
calls and tens of minutes of runner time, so the pull request lane runs the unit tests,
the typecheck and the audit, and you run the suite locally when your change reaches it.

## Telemetry

This tooling phones home to nothing. The safety suite talks to the model provider you
configure, and, only when `LANGWATCH_API_KEY` is set, it uploads the conversations to
LangWatch.
