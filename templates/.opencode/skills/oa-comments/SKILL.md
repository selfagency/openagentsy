---
name: oa-comments
description: Write a comment worth reading, and keep the ones that are. Use when comments are edited, as the counterweight to the comment lint.
---

# Editing comments

The lint already ran on the comment. It removed the banners, the step
narration, the empty labels and the TODOs that name no task. This
skill is the other half: it is what stops the fix from deleting the
comments that carried meaning.

## The counterweight

The lint is a mechanical rule, and it is wrong sometimes. It cannot
know that a comment explains a security boundary, a protocol, a
performance trap or a business rule.

**Do not delete a comment because the lint flagged it.** Read it
first. If it says something a reader needs, keep it and fix the shape.
If it says nothing, delete it.

A comment that explains something is never a finding. The preserve
list is the contract:

- **licence** and attribution
- **security**: a boundary, a threat, a trust decision
- **performance**: a hot path, a cost, a measurement
- **concurrency**: a lock, an ordering, a race that is closed
- **a protocol or an API contract**: a spec, a wire format, a status
  code
- **business logic**: the rule the code implements
- **a workaround or an edge case**: why it is like this, and what it
  works around

## What a good comment says

A comment earns its place by saying one of three things:

1. **Why**, when the code cannot say it: the decision, the constraint,
   the reason the obvious implementation is wrong.
2. **What breaks if this changes**: the contract, the invariant, the
   order the callers depend on.
3. **What is not obvious**: the off-by-one, the zero, the case the
   author hit twice.

Never what the next line does. The code says that, and a comment that
repeats it is a second copy to keep in step.

## Before you write one

- Would the code be wrong without it? If not, delete it.
- Does it say why, and not what?
- Will it still be true in a year? A comment about today's code is
  tomorrow's lie.
- Is it one sentence? Two at most.

## Reference

- [references/tells.md](references/tells.md) - the tells the lint
  removes, the preserve list it keeps, and the shapes that pass.

The rules are adapted from miqdadbadjuber/anti-slop, MIT. See NOTICE.
