---
name: openagentsy-handoff
description: Write a board record that another agent can act on without reading your transcript. Use when reporting progress, handing off a contract, raising a question, or posting a blocker.
---

# Writing a board record

A board record is a hand-off. It replaces your transcript, so it has to carry
everything the next agent needs and nothing it does not.

## The record

```json
{
  "bean": "proj-42",
  "from": "builder-2",
  "kind": "status | contract | question | blocker | finding",
  "action": "Added GET /search?q= handler",
  "state": "tests: 14/14 pass; owns src/api/search.ts",
  "artifact": "commit a1b2c3 on wt/proj-42",
  "contract": { "GET /search": "-> [{id,title,url}]" },
  "needs": "frontend (proj-43) consume contract",
  "surprise": "Existing index lacks a title column, migration added",
  "confidence": "verified | inferred | guess"
}
```

## Which kind

| Kind | Use it when | The next agent needs |
| --- | --- | --- |
| `status` | A unit of work finished | The artifact and the test result |
| `contract` | Another agent will call your work | The exact shape of the interface |
| `question` | The plan looks wrong, or you need a decision | The specific question and who can answer it |
| `blocker` | You cannot continue | What is missing and from whom |
| `finding` | A review or investigation turned something up | Where it is and how to reproduce it |

## Rules

1. **Keep it under 150 tokens.** If it does not fit, the record is missing
   detail, not the tool being slow.
2. **One record per state change.** Do not batch a day of work into one record.
3. **Name the artifact.** A commit hash, a file path, a test name. A record
   that says "done" without a handle is not actionable.
4. **Fill `surprise` when you learned something the plan did not know.** This is
   the field that carries the fact only you hold. An empty `surprise` on a
   record where something surprising happened loses information nobody else has.
5. **Label every claim.** `verified` means you ran it or read it. `inferred`
   means you reasoned to it. `guess` means you did not check. A guess labelled
   `verified` poisons the next decision.
6. **`needs` names the consumer.** Write which agent or bean has to act, not
   just that something is needed.
7. **A `question` record is not a complaint.** It states the problem, the
   evidence, and the options you can see. If the plan is wrong, say so instead
   of complying.
