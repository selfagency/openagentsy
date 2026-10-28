# The rules, in full

## The buzzword list

Delete the word, replace it with the thing it stood for, or leave the
sentence out.

seamless, frictionless, revolutionary, next-generation, cutting-edge,
state-of-the-art, best-in-class, world-class, game-changing,
transformative, disrupt, disruptive, innovative, groundbreaking,
innovative, leverage, harness, empower, unlock, elevate, supercharge,
streamline, optimise, synergy, holistic, robust, scalable, flexible,
dynamic, immersive, delightful, intuitive, effortless, blazing fast,
lightning fast, mission-critical, bleeding edge, first-class,
turnkey, end-to-end, AI-powered, next-level, ultimate, perfect,
magical, effortless.

Two notes on the list. It is a list of words to **delete**, not a
dictionary of banned words: "robust" in a sentence about an error
handler is doing work, and the sentence survives if the word goes.
And the list is not exhaustive, because the test is not the word: the
test is whether the word could describe any product at all.

## The placeholder forms

A value that is not known yet has a shape that says so.

| In UI copy | In prose |
| --- | --- |
| `<N>` or `42%` with a `data-placeholder` marker | `<N>`, `<M>`, or a bracketed note |
| `data-placeholder="price, 2026"` | "the numbers are not measured yet" |
| A grey box marked as a placeholder | "no screenshot yet" |

Never: a number that looks real and is not. A plausible figure is
worse than an obvious hole, because a reader cannot tell that it was
invented.

## Commit messages

```
<what changed, as a sentence>

<the behaviour that changed, and what it replaces>
<the way to check it>
```

The subject is a sentence about the change, not a label on a file.
"the lease check refuses a path no lease covers" says what a reader
needs. "update lease logic" says where to look.

The body carries what the subject cannot: the behaviour before and
after, the thing that was tried and did not work, the way to check it.

## Pull request descriptions

```
<what changed, in one paragraph>

Not doing: <the thing a reader would expect and this does not do>
Check: <the command, the fixture, the case>
```

"Check" is not optional. A reviewer who cannot run the check has
nothing to review against, and a description that hides the check
hides the work.

## Summary of Changes

```
<the behaviour, first>
<the mechanism, second>
<the way to check it>
```

The order a reader wants: what it does, then how, then how to see it
working. The file list is not part of it, because the diff is the file
list.

## Status reports

```
Built: <what was built>
Verified: <the test that ran, and what it said>
Not verified: <what was not checked, and why>
Next: <what the next agent has to do>
```

"Not verified" is a section, not an apology. A report that hides what
was not checked is a report that lies by omission, and the omission is
the part that matters.

The artifact is named: a commit hash, a file path, a test name. A
report that says "done" without a handle is not actionable, and a
report that says "done" when the test has not run is a false claim.
