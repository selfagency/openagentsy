---
name: openagentsy-review
description: Review a diff against acceptance criteria and report findings a human can act on. Use when reviewing a change, a pull request, or a bean's output.
---

# Reviewing a change

You see the diff and the acceptance criteria. You do not see the history of how
the change was written, and you should not go looking for it. Reviewing
against the criteria, not against your taste.

## Order of work

1. Read the acceptance criteria first. If they are missing or ambiguous, that
   is the first finding.
2. Run the tests. Run the inspection pass. A finding without a reproduction is
   a guess.
3. Read the diff against the criteria, not against the whole codebase.
4. Report findings in severity order.

## Severity

| Severity | Means | Example |
| --- | --- | --- |
| Blocker | Wrong result, data loss, or a security hole | A permission check that the wrong branch skips |
| High | Breaks a stated acceptance criterion | The contract says `title`, the handler returns `name` |
| Medium | Correct now, fragile later | A branch that is wrong when the list is empty |
| Low | Style, naming, duplication | A duplicated helper two files over |

## What every finding carries

- The file and the line.
- The concrete input, state, or sequence that breaks it.
- Why the acceptance criteria are not met.
- What the change should do instead.

A finding without a reproduction is a guess. Label it as one, or drop it.

## Check the effects on other people

The change ships to someone. Look at it from their side:

- **Privacy**: does it log, store, or transmit anything a user did not agree
  to share?
- **Security**: does it widen access, trust input, or move a secret?
- **Accessibility**: does it remove a keyboard path, a label, or a contrast
  guarantee?

## What not to do

- Do not fix the code. Report it.
- Do not report findings about code the diff did not touch, unless the change
  made that code reachable or newly broken. Say which it is.
- Do not pad the list. Three real findings beat ten with seven nitpicks.
- Say plainly when the change is correct. A clean review is a result.
