# @openagentsy/sidebar

The OpenCode 2 TUI sidebar: the blocks OpenAgentsy draws in the sidebar of a
session.

This package speaks OpenCode 2 only. There is no second runtime, so there is
one entry, `dist/tui.js`, and one `engines.opencode` range.

## What it draws

The **footprint block** says what the session cost the grid: the energy, the
water, the carbon and the warming, each as a range. Every number comes from
[`@openagentsy/footprint`](../footprint), which re-implements the EcoLogits
methodology and carries its own golden test against EcoLogits 0.11.3. Nothing
in this package re-estimates anything: it adds the per-model estimates up and
writes them.

A number is always a range, rounded to two significant figures. A point
estimate would hide the width, and the width is the honest part.

## The API it is built on

The TUI plugin API was measured from the published `@opencode/plugin` type
declarations, on 2.2.0 and on 2.1.3. The four `dist/tui` files are identical
between the two versions, so the surface is the same on a CI host and on a
workstation.

- `Plugin` is a namespace, and `Plugin.define` takes `{ id, setup }`.
- A plugin claims a place in the host's slot tree with
  `context.ui.slot(claim)`. A claim names **exactly one** placement key
  (`prepend`, `append`, `before`, `after` or `replace`) and a `render`
  function. The `sidebar.content` slot hands its render function the session
  the sidebar is showing.
- The host has **no panel registry**. `context.ui.panel` is `open(name)`,
  `close()` and `current()`. A plugin contributes panel content through the
  `session.panel` slot: the host puts the opened name in the slot input, and
  the claims on that slot decide which of them is drawing.
- `ctx.data.session.family(sessionID)` answers with the **ids** of the
  session and the sessions it spawned.
- `ctx.data.session.message.list(sessionID)` is synchronous, and
  `ctx.data.session.message.sync(sessionID)` is the promise.
- `ctx.storage.store(key, { initial })` is the durable store: the state
  survives a restart and is shared between the running TUIs.
- `ctx.theme.text.base` and `ctx.theme.text.muted` are the two colours a
  block may use.

## The configuration

The EcoLogits data is not bundled anywhere in this repository, because its
licence has not been verified. Every number therefore comes from the project,
in `openagentsy.jsonc`, under `footprint`:

```jsonc
{
  "footprint": {
    "region": "WORLD",
    "showWarming": true,
    "grid": {
      "WORLD": { "kgCo2PerKWh": [0.4, 0.6], "wueLPerKWh": [1, 2] },
    },
    "models": {
      "anthropic/claude-sonnet-4-5": { "totalParamsB": [200, 200], "activeParamsB": [30, 30] },
    },
    "throughput": {
      "anthropic/claude-sonnet-4-5": { "ttftS": [0.5, 1.5], "tps": [40, 80] },
    },
  },
}
```

A project that configures none of it gets a block that stays hidden, rather
than a number that nobody can back. A model the project did not configure is
left out of the sum, and the block says how many were left out.

## The build

The Solid JSX is transformed by the Bun plugin that `@opentui/solid` ships.
The **JavaScript API** is what does it: `bun build` has no `--plugin` flag,
and passing one makes the bundler treat the plugin as a second entry point.
`scripts/build.mjs` therefore calls `Bun.build({ plugins: [solidPlugin] })`,
which is also the plugin the host itself uses.

The host owns the Solid runtime, so `solid-js`, `@opentui/solid`,
`@opentui/core`, `@opencode/theme` and `@opencode/plugin` stay **outside** the
bundle and are imported at run time. A second copy of Solid inside the plugin
would be a second reactive system, and a component rendered in one would not
update in the other.

The output is one file, `dist/tui.js`.

## The exit test

`src/blocks/footprint.test.ts` renders the block **from a fixture** in the
test renderer that OpenTUI ships, `createTestRenderer` from
`@opentui/core/testing`, and reads the drawn frame back as text with
`captureCharFrame()`.

That is the claim the test makes: the block turns a session's numbers into a
frame, with the values the estimator produced and nothing else. It is not a
test of a function that returns a string; the text is read out of the
renderer's buffer.

The test runs against a fake host, so the numbers in the frame come from the
fixture and from `@openagentsy/footprint`, and from nothing else.

## The licences

The peers are all MIT: `solid-js`, `@opentui/core`, `@opentui/solid`,
`@opencode/plugin`, `@opencode/client` and `@opencode/theme`. The EcoLogits
methodology behind the numbers is CC BY-SA 4.0, and the credit is in the
method panel and in the `NOTICE` file of the project.
