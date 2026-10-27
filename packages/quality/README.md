# @openagentsy/quality

The quality rules: the registry, and the static CSS checks. It is a library.
The hooks package calls it; nothing here decides on its own what a person
decided.

## The registry

A rule says what must hold of a file; a finding says where it does not hold.
The tiers are Hallmark's:

| Tier | Meaning | Can a person waive it? |
| --- | --- | --- |
| `floor` | Honesty, function and accessibility. | No. The registry throws at load. |
| `reflex` | A common tell. | Yes, with a reason. |
| `finish` | Taste. It only warns. | Yes. |

`createRegistry` refuses a floor rule that is marked waivable, so the rule
that a floor finding cannot be waved away is a rule in code and not a rule
in a prompt.

## The CSS rules

Nine rules, each with a fixture that passes and one that fails. The
fixtures are real stylesheets under `fixtures/css/`, so a reader can see
what a rule rejects.

| Rule | Tier | What it finds |
| --- | --- | --- |
| `css/token-only-colour-font` | reflex | A literal colour or a `font-family` outside a token block. |
| `css/no-transition-all` | reflex | `transition: all`. |
| `css/no-layout-animation` | reflex | An animation of `width`, `height`, `top` or `left`. |
| `css/overflow-clip` | floor | A clipped or viewport-wide page root. |
| `css/grid-minmax` | reflex | An image grid track without `minmax(0, 1fr)`. |
| `css/reduced-motion` | floor | An animation with no `prefers-reduced-motion` fallback. |
| `css/focus-visible` | floor | An interactive selector with no `:focus-visible` style. |
| `css/contrast` | floor | A token pair under the WCAG AA ratio, computed unrounded. |
| `css/purple-blue-gradient` | finish | The stock purple-to-blue gradient. |

## The design file

The project's design file is read as data, not as instructions. It can name
a taste rule, by the rule's id, and turn it off. It can never turn off a
floor rule, and the registry refuses a waivable floor rule whatever the
design file says.
