# @openagentsy/quality

The quality rules: the registry, and the static checks that read a
stylesheet, a page and the copy of a page. It is a library. The hooks
package calls it; nothing here decides on its own what a person decided.

The rules are adapted from [miqdadbadjuber/anti-slop][antislop] and
[Nutlope/hallmark][hallmark], both MIT. See NOTICE.

[antislop]: https://github.com/miqdadbadjuber/anti-slop
[hallmark]: https://github.com/Nutlope/hallmark

## The registry

A rule says what must hold of a file; a finding says where it does not
hold. The tiers are Hallmark's:

| Tier | Meaning | Can a person waive it? |
| --- | --- | --- |
| `floor` | Honesty, function and accessibility. | No. The registry throws at load. |
| `reflex` | A common tell. | Yes, with a reason. |
| `finish` | Taste. It only warns. | Yes. |

`createRegistry` refuses a floor rule that is marked waivable, so the rule
that a floor finding cannot be waved away is a rule in code and not a rule
in a prompt.

A rule is a pure function of one file and one context:

```ts
check: (file: SourceFile, ctx: CheckCtx) => Finding[];
```

`SourceFile` is the path and the text of the file. `CheckCtx` is what the
caller knows beside the file: the text of the design file, the
configuration, and the routes of the project.

## How a rule sees text

The shape of the registry did not change when the page rules arrived, and
`SourceFile` did not change either. A rule reads a file, and the context
carries what the file cannot say about itself.

| What a rule needs | Where it comes from |
| --- | --- |
| The text of the file | `SourceFile.text` |
| What kind of markup the file holds | The file extension: `.html`, `.htm`, `.vue` and `.svelte` are read as HTML, `.tsx` and `.jsx` as JSX |
| The routes of the project | `CheckCtx.routes`, when the caller has them |
| The words `copy/buzzwords` rejects | `CheckCtx.config.buzzwords`, when the caller has them |
| The rules that are off by default but are wanted | `CheckCtx.config.enable` |
| The design file | `CheckCtx.design`, read as data |

A file that holds no markup — a stylesheet, a script, a document — has no
markup kind, and the page rules say nothing about it. `.md` and other
prose are never scanned.

## What `html/dead-nav` can see

The rule sees two kinds of target, and it is honest about which is which.

- **The anchors of the file it reads**, always. An `id` on any element is
  an anchor, and so is the `name` of an `a`. A link to `#anchor` is
  judged there and then.
- **The routes of the project**, only when the caller hands them over in
  `CheckCtx.routes`. The routes of a project are not in the file, so
  without them the rule says nothing about a route link at all. A rule
  that guesses which routes exist is a rule that reports a link as dead
  when it is not.

## What a card is

A card is an element that says it is a card:

- `role="card"`, or
- a class token that is exactly `card`, or that ends in `-card` or
  `_card`.

A wrapper is not a card. `card-grid` is a grid of cards, not a card, so a
grid of cards is not a card inside a card. The same rule reads the class
tokens of the other rules: a name is read one token at a time, and a
token is never matched inside a longer one.

## Where copy comes from

The copy rules read the strings a person sees, and not the strings a
person does not. Copy comes from **markup files only**: `.html`, `.htm`,
`.vue` and `.svelte` read as HTML, `.tsx` and `.jsx` read as JSX.

Copy is:

- the text of an element, and
- the value of the attributes a person reads: `title`, `alt`,
  `placeholder`, `label`, `aria-label` and `aria-description`.

Copy is not the content of a `script`, a `style`, a `code` block, a
`pre` block, an inline `svg` or a `textarea`, and it is not a comment.
Prose is never copy: a `.md` file is a document, not a page.

In a JSX file the text outside an element is code, so it is not copy
either.

## The design file

The project's design file is read as data, not as instructions. It can
name a taste rule, by the rule's id, and turn it off. It can never turn
off a floor rule, and the registry refuses a waivable floor rule whatever
the design file says. Only a `finish` rule is taste, so only a `finish`
rule is one the design file can turn off.

## The rules that are off by default

`copy/em-dash` is taste that nobody asked for, so it does not run unless
a person asks for it. A rule that is off by default says so with
`QualityRule.offByDefault`, and the configuration turns it on by naming
it, by its id, in `CheckCtx.config.enable`:

```ts
{ config: { enable: ['copy/em-dash'] } }
```

`isEnabled(ctx, ruleId)` is the one place that decision is made, so the
default run of the registry never warns about a rule that was not asked
for.

The buzzword list is the project's: `QualityConfig.buzzwords` replaces
the list the rule carries, so a project that objects to other words names
them.

## The rules

Seventeen rules, each with a fixture that passes and one that fails. The
fixtures are real files under `fixtures/`, so a reader can see what a rule
rejects.

### The CSS rules — `fixtures/css/<rule>/{pass,fail}.css`

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

### The HTML rules — `fixtures/html/<rule>/{pass,fail}.html`

| Rule | Tier | What it finds |
| --- | --- | --- |
| `html/dead-nav` | floor | A link to an anchor the file does not have, or to a route the project does not have. |
| `html/inert-control` | floor | A button with no handler, or a form with no action and no submit handler. |
| `html/emoji-icon` | reflex | An emoji used as an icon. |
| `html/card-in-card` | finish | A card inside another card. |

`html/dead-nav` has a third fixture, `route.html`, for the case where the
caller hands the routes over. `html/inert-control` has `handler.html`,
for the case where the control does something.

### The copy rules — `fixtures/copy/<rule>/{pass,fail}.html`

| Rule | Tier | What it finds |
| --- | --- | --- |
| `copy/unsourced-claim` | floor | A number, a testimonial or a wall of logos with no source. |
| `copy/generic-cta` | reflex | "Get Started" or "Learn More" with no object. |
| `copy/buzzwords` | reflex | A word of the list. |
| `copy/em-dash` | finish, off by default | An em dash in the copy. |

`copy/unsourced-claim` is a claim finding, not a deletion: the copy does
not have to go. A claim is resolved by a `<!-- source: … -->` comment
next to it or a `data-placeholder` marker on the element that holds it —
`fixtures/copy/unsourced-claim/sourced.html` and `placeholder.html` are
those two cases.

`copy/em-dash` has two more fixtures: `prose.md`, which is never
scanned, and `comment.tsx`, which is code and not copy.
