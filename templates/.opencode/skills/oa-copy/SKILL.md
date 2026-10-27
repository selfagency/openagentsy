---
name: oa-copy
description: Write copy a person acts on, and write the prose an agent writes. Use when a change touches user-facing copy or agent prose - a commit message, a pull request description, a task Summary of Changes, a Lead status report.
---

# Writing copy

Two kinds of copy carry this skill: the copy a reader of the product
sees, and the prose an agent writes about the work. Both are read by a
person deciding something, and both fail the same way.

## A call to action names its object

"Get Started" is not a call to action. "Start the migration" is.
"Learn more" is not a call to action. "See the pricing table" is.

If a button does not say what happens when it is pressed, the button
is the bug, not the label.

The same holds for a link, a menu item, an empty state and a heading
that asks for something: name the object, name the action, say it in
the fewest words that still say it.

## No buzzwords

The words that could describe any product are words that describe
none: seamless, revolutionary, next-generation, cutting-edge,
game-changing, world-class, best-in-class, leverage, empower, unlock,
elevate, supercharge, transform, disrupt, synergy, holistic,
frictionless, delightful, intuitive, robust, state-of-the-art.

Delete the word. Replace it with the thing it stood for, or leave the
sentence out. "A seamless experience" becomes "the form keeps what you
typed when the request fails".

## No fake stats

A number with no source is an invented fact. "10x faster" is a claim
about a measurement nobody made. A ratio, a percentage, a count of
customers, a time saved: it is either sourced or it is a placeholder.

- **Sourced**: "Cut the build from 42s to 9s on the CI runner", and
  the measurement is in the change.
- **Placeholder**: "Cut the build from <N>s to <M>s", with a note
  saying the numbers are not measured yet.

Never a number that looks real and is not.

## Agent prose

The same three rules hold for the prose an agent writes, because a
person reads it to decide something.

**A commit message says what changed and why.** The subject is a
sentence: "the lease check refuses a path no lease covers", not
"update lease logic". The body says what a reader has to know: the
behaviour that changed, the thing it replaces, the way to check it.

**A pull request description says what a reviewer must see.** What
changed, in one paragraph. What it does not do, in one line. How to
check it: the command, the fixture, the case. A reviewer who has to
guess the acceptance criteria is reading a description that failed.

**A Summary of Changes says what changed, in the order a reader wants
it.** The behaviour first, then the mechanism, then the way to check
it. No file list: the diff is the file list.

**A status report says what is true.** What was built, what was
verified, what was not, and what is next. A report that says "done"
without naming the artifact is not a report, and a report that says
"done" when the test has not run is a false claim.

## Reference

- [references/prose.md](references/prose.md) - the buzzword list, the
  placeholder forms, and the commit, pull request, summary and report
  skeletons.

The rules are adapted from miqdadbadjuber/anti-slop, MIT. See NOTICE.
