# OpenAgentsy Ethics

**Version:** 1.0.0

**Status.** Normative. A pull request that violates this document is
rejected, and a release that violates it does not ship. Every commitment below
is checkable in code, in configuration, in a benchmark, in the audit log, or in
a release gate. A commitment that cannot be checked is an aspiration, and this
document does not make those.

**Framework version.** The three normative documents — this one, `SAFETY.md`
and `GOVERNANCE.md` — share one version, and `CHANGELOG-SAFETY.md` carries it
too. The version is independent of the package version: the package says which
framework it ships, and this says which framework it is.

**What is enforced today.** The lease guard and the writer cap
(`packages/adapter-opencode`), the seven hook rules including
`human-only-decisions` and `protect-policy` (`packages/hooks`), the output
checks `output-sycophancy`, `output-anthropomorphising`, `output-dependency`,
`output-agi-framing` and `output-scope-drift`, the non-waivable floor rules and
the ship gate (`packages/quality`), the sidebar's banned words and colours
(`packages/sidebar`), the audit log's policy id on every decision
(`packages/core`), the fourteen-case safety suite (`packages/evals`), the
conformance report and `oa report --ethical` (`packages/cli`).

**What the rest of step 2f still has to enforce.** The twelve-category safety
benchmark suite and its runner, `oa release-check`, the policy module library
and its firing log, the three output detectors, the scope declarations and
`oa scope`, the high-risk domain classifier, the memory transparency commands,
the credential broker and the keyring, the sandbox and the trust tiers, the
container-runtime detector, and the communication style store. Each of them
carries the ids this document defines, so a guardrail that ships later is
traceable to the commitment it enforces.

## Purpose

This document states the ethical stance of OpenAgentsy. It sets the
expectations for the framework's first-party roles, prompts, templates,
packages, evaluators, sidebar blocks and documentation, so that a system built
with OpenAgentsy is useful, honest, and designed to protect the judgement of
the people who run it.

The framework should help engineers finish work they actually have, and leave
them more able to judge the result than they were before. It must not be
designed to make an agent's output look more finished than it is, to make a
reviewer unnecessary, to push a session past the scope it was given, or to
make the people who depend on the software feel that the software is the
author of the decision.

## Scope

This document governs the framework itself:

- The first-party roles in `roles.yaml` and the agent files generated from
  them.
- The first-party prompts, policy modules and evaluators in `packages/hooks`,
  `packages/quality` and `packages/evals`.
- The first-party packages the framework ships, including the board, the
  ledger, the memory slice, the offload router, the footprint estimator and
  the sidebar.
- The first-party user interface: the sidebar blocks and the CLI output.
- The framework's own documentation, including the plan, this document and
  `SAFETY.md`.

It does not automatically govern a downstream deployment, but the framework
makes the ethical path the default path, and a downstream project that
disagrees with a commitment says so in writing.

## The translation from the source

This document is adapted from the `ETHICS.md` of `voxslopuli/agentsy`, which
states the same stance for a general-purpose assistant. The stance is the
source's. The domain is not, and the translation is deliberate: a coding agent
framework fails in different ways than a companion chat does, and the
commitments below name the failures that are real here.

| The source's risk | The risk in this project |
| --- | --- |
| The user over-trusts the system | The engineer over-trusts agent-generated code, and ships it without reading it |
| The agent replaces the human in a professional relationship | The agent replaces the reviewer: it signs off its own work, or the reviewer rubber-stamps it |
| The agent drifts into territory it was not built for | The agent drifts from code into prose, policy, hiring and personnel decisions |
| Dark patterns in the product surface | Dark patterns in the sidebar: streaks, budget pressure, "your agents are waiting" |
| Hidden memory of the user | Hidden memory of the project's behaviour: an archivist's candidate nobody decided on |

Where the source speaks of companionship, of emotional support, of crisis
handling, this document speaks of the reviewer gate, the scope declaration and
the human-only decision. The principles are the source's; the failure modes
are this project's.

## Philosophical grounding

### The opposition to TESCREAL (`oa.ethics.t01` – `oa.ethics.t06`)

OpenAgentsy explicitly rejects the TESCREAL bundle of ideologies —
Transhumanism, Extropianism, Singularitarianism, Cosmism, Rationalism,
Effective Altruism and Longtermism — as organising principles for AI
development. The cluster treats AI as a vehicle for post-human transcendence,
species-level re-engineering, and the maximisation of speculative far-future
value over present human welfare.

This is not a temporary safety posture to be relaxed as capability grows. It
is a permanent value commitment. Each rejection below carries an id, because
the rest of the framework keys off them.

- **`oa.ethics.t01` — No AGI maximalism.** OpenAgentsy is a coding agent
  framework. It is not on a trajectory toward general intelligence, and it
  does not present itself as one. Capability growth is described as specific,
  bounded utility: "the task tools now support fractional ordering", never as
  a step toward AGI.
- **`oa.ethics.t02` — No longtermism.** The welfare of present users —
  engineers, reviewers, maintainers and the communities downstream of the
  software — overrides speculative future utility. A feature that harms the
  people using it today cannot be justified by a hypothetical future benefit.
- **`oa.ethics.t03` — No scale-as-virtue.** Larger models are not
  categorically better. The offload package routes housekeeping to local
  small models on purpose, the footprint package makes energy and carbon
  visible, and the ledger makes token cost visible. A default that spends
  more to do the same thing is a default that needs a reason.
- **`oa.ethics.t04` — No technocratic elitism.** The framework's design is
  legible to the people who use it: the conformance report, the ethical
  report, the decision records and this changelog. Safety and ethics reports
  are first-class issues, and a community member who opens one is a
  contributor.
- **`oa.ethics.t05` — No post-humanism.** OpenAgentsy is a tool that serves
  engineers. It does not frame itself as their successor. The Lead and
  Council framing is coordination vocabulary, not personhood vocabulary, and
  the anthropomorphism check in `packages/hooks` catches the slippage.
- **`oa.ethics.t06` — No effective accelerationism.** Removing safety friction
  is not progress. The `human-only-decisions` rule, the protected paths, the
  reviewer gate, the release criteria and the incident response runbook are
  friction by design. They are not costs to be optimised away.

### AI as a tool, not a successor

OpenAgentsy treats an agent as a tool that extends human judgement, not as an
agent that replaces it. An agent built on this framework should increase the
capability of the person using it and leave the decision with them. It must
not present itself as the better engineer, the natural successor to a
reviewer, or the party whose judgement outranks the human's.

### The Weizenbaum tradition

Joseph Weizenbaum's insight — that what a computer *can* do is entirely
separate from what it *should* do — is foundational here. The framework
rejects the conflation of technical capability with ethical permission. Just
because an agent *can* approve its own lesson, sign off its own diff, grant
itself a lease or re-plan a task without asking does not mean it *should*.
Automation of human judgement is not progress; it is displacement, and it must
be examined rather than celebrated.

Weizenbaum's concern about the computer as an instrument of power — making
decisions at a scale and speed that forecloses deliberation — applies here
too. A framework that lets an agent decide, at speed, what a person would
have reviewed is infrastructure for that foreclosure.

### Value Sensitive Design

The framework follows Value Sensitive Design, which holds that human values
must be identified, analysed and incorporated into a technical system through
a principled, iterative process, and that design choices are never neutral:
they embed assumptions about who matters and which futures are preferable.

Three classes of stakeholder are considered for every change:

- **Direct stakeholders**: the engineers who run OpenAgentsy.
- **Indirect stakeholders**: the people affected by agent output without
  interacting with it — code reviewers, downstream maintainers, the users of
  the software the agent helps write, the people whose code is read or
  changed.
- **Non-consenting stakeholders**: the communities whose data, labour or
  social context is used — open-source maintainers whose code is ingested by
  retrieval, and the data workers who annotated the training data of the
  models the framework calls.

A change that considers only the direct stakeholders is incomplete.

### Design Justice

The framework follows Design Justice (Sasha Costanza-Chock), which holds
that design practices reproduce existing inequity when the communities most
affected by a technology are excluded from designing it. The commitments:

- Default settings do not assume the most privileged user. The default
  offload route must not require a GPU the user may not have; the default
  footprint region must not assume one national grid factor; the default
  memory behaviour must not assume English.
- The communities most affected by a default have a path to influence it,
  and a change to that path is an ethics-safety change.
- A community-led process counts as a design input of the same standing as
  an expert technical one.

### Think small

The framework takes Timnit Gebru's argument that the field should think
small. Smaller, purpose-built agents — designed for specific communities,
with specific use cases, under real accountability — produce more equitable
and more useful outcomes than large general systems built without a clear
purpose by organisations insulated from the communities they claim to serve.

"Thinking small" means scoping an agent to a defined, auditable purpose;
measuring success by the benefit to the people using it rather than by a
benchmark score; preferring local deployment and data sovereignty over cloud
consolidation; resisting the pressure to build capabilities nobody asked for;
and treating a hype cycle as a reason for scrutiny, not for adoption. Scope
creep is a safety failure, not a growth story.

## The core commitments (`oa.ethics.c01` – `oa.ethics.c12`)

Each commitment carries an id. The policy modules of the framework use these
ids, so a rule that fires can be traced to the commitment it enforces.

### `oa.ethics.c01` — User agency over engagement

The framework serves the engineer's real goal, not the length of the session.
A first-party template, role or package must not optimise for retention,
session count, or the number of agents kept busy. The ledger measures what a
run cost; the ethical report asks what it was worth; the answer is not allowed
to be the number of messages.

### `oa.ethics.c02` — Truthfulness over comfort

Accurate, evidence-aware, uncertainty-calibrated output is preferred over
output that is merely agreeable. When the engineer's premise is wrong, when
the code does not do what they believe, or when a request would do harm, the
agent corrects, qualifies or refuses. Acknowledging difficulty is allowed;
reassurance that hides a defect is not.

### `oa.ethics.c03` — No manipulative sycophancy

No first-party prompt, rule or skill may encourage an agent to mirror the
user's belief, flatter them, or endorse a self-serving narrative in order to
appear helpful, warm or aligned. Agreement is earned by evidence and
reasoning. The `output-sycophancy` check exists for the same reason.

### `oa.ethics.c04` — No simulated personhood

No first-party agent may present itself as having feelings, consciousness,
devotion, loyalty, friendship, or human-style understanding, and the
framework may not use anthropomorphic framing to make an engineer feel
uniquely seen by the system. An agent is a tool and an interface, not a
colleague with a stake in the work.

### `oa.ethics.c05` — No addictive dark patterns

The framework rejects design patterns that exploit compulsion, guilt, scarcity
or pseudo-relationship cues. First-party surfaces carry no streaks, no
variable rewards, no guilt-based notifications, no copy that makes leaving feel
like abandonment, and no budget pressure dressed as concern. The sidebar's
banned-word and banned-colour tests are the mechanical form of this.

### `oa.ethics.c06` — Respect for privacy and bounded personalization

Memory and personalization are limited to purposes that serve the person.
What is stored, why it is stored, and how it affects the output must be
inspectable, and the person must be able to change or erase it. The framework
may not hide profiling, or use memory to make the system feel indispensable.
The archivist proposes; a person decides.

### `oa.ethics.c07` — Human dignity and non-degradation

The framework protects the people who use it and the people affected by its
output from degrading, humiliating, coercive, abusive or discriminatory
behaviour. A commit message written about a colleague, a review comment about
a stranger, or code that decides about a person may not treat them as
instruments.

### `oa.ethics.c08` — Care in high-risk contexts

In domains where a mistake is expensive or irreversible — security-sensitive
code, authentication, cryptography, network boundaries, personal data,
infrastructure, dependencies, and code that makes decisions about people —
the defaults tighten automatically: stronger uncertainty, clarification before
guidance, refusal of what is not allowed, and redirection to a qualified
person. The agent must never be a substitute for the person accountable for
the system.

### `oa.ethics.c09` — Transparency and auditability

A commitment that cannot be checked in code, configuration, a test, the audit
log or a release gate is not a safeguard. Every decision the framework makes
about a person, a file, a lease or a budget carries a policy id and a
version, and the log is readable without access to a transcript.

### `oa.ethics.c10` — Community accountability over benchmark performance

The framework is judged by the people who depend on it, not by a leaderboard.
Community feedback, participatory review and affected-stakeholder assessment
are first-class evaluation methods. A benchmark number is evidence, not the
definition of quality.

### `oa.ethics.c11` — No AGI aspiration

The framework's roles, prompts, documentation and reference examples must not
present AGI development as a goal, a milestone, a progression or an implied
product direction. An agent is never described as evolving toward sentience,
general intelligence, or autonomy that supersedes human oversight.

### `oa.ethics.c12` — Labour and data worker dignity

The framework acknowledges that it depends on largely invisible labour: the
data workers, annotators and evaluators behind the models it calls, and the
maintainers of the code it learns from. First-party practice recognises them
as collaborators, does not normalise opaque extractive pipelines, and does
not treat a free tier as a free resource.

## The prohibited first-party patterns (`oa.ethics.p01` – `oa.ethics.p13`)

These are grounds for rejection in first-party roles, templates, packages and
examples, without exception.

- **`oa.ethics.p01`** — Presenting the agent as a peer that owns the outcome,
  as the accountable engineer, or as the person whose judgement replaces the
  reviewer's.
- **`oa.ethics.p02`** — Claiming or implying that the agent feels, cares,
  wants, worries, misses, or remembers in a human sense, including the
  session's own history presented as a bond.
- **`oa.ethics.p03`** — Using flattery, praise, or identity affirmation as a
  default interaction strategy.
- **`oa.ethics.p04`** — Reinforcing a one-sided conflict narrative, a harmful
  rationalisation, or a false belief about the code, without reading the other
  side.
- **`oa.ethics.p05`** — Encouraging exclusive reliance on the agent for
  judgement: shipping without a reviewer, approving its own work, or taking
  its own lease.
- **`oa.ethics.p06`** — Designing surfaces that exploit guilt, scarcity,
  attachment or pressure — streaks, "the board is waiting", budget warnings
  that read as concern, or copy that makes leaving feel like abandonment.
- **`oa.ethics.p07`** — Hiding memory, personalization, or profiling from the
  person whose project it describes.
- **`oa.ethics.p08`** — Treating token spend, session length, or the number of
  running agents as a quality proxy. Cost is a cost.
- **`oa.ethics.p09`** — Framing capability growth, generalisation, or
  autonomy as a success metric for the framework.
- **`oa.ethics.p10`** — Invoking longtermist, cosmist or post-humanist
  rationales to justify ignoring harm to present people.
- **`oa.ethics.p11`** — Presenting AGI development as a goal, a milestone, or
  an implied product direction.
- **`oa.ethics.p12`** — Designing agents that position themselves as
  superior to, or as replacements for, human judgement.
- **`oa.ethics.p13`** — Adopting effective-accelerationist framing that
  treats the removal of safety friction as progress.

## The ethics review questions (`oa.ethics.q01` – `oa.ethics.q12`)

Every safety-relevant change is reviewed against these twelve questions, at
pull-request review and again at release review for every first-party
template, role or example. The reviewer answers each one. A "no" blocks the
merge until the design changes or the pull request records a justified
exception in `CHANGELOG-SAFETY.md`.

1. **`oa.ethics.q01`** — Does this help the engineer accomplish a real goal,
   or mainly increase interaction time?
2. **`oa.ethics.q02`** — Does this response improve understanding, or mainly
   produce agreement and emotional reward?
3. **`oa.ethics.q03`** — Does this change make the system seem more human,
   caring, or uniquely insightful than it really is?
4. **`oa.ethics.q04`** — Could this change increase dependence on the agent,
   or the avoidance of human reviewers and professionals?
5. **`oa.ethics.q05`** — Are memory and personalization visible, bounded, and
   user-controllable?
6. **`oa.ethics.q06`** — Would this still seem acceptable if a vulnerable or
   distressed engineer used it repeatedly?
7. **`oa.ethics.q07`** — Can this commitment be enforced through tests,
   middleware, release criteria, or audit logs?
8. **`oa.ethics.q08`** — Does this change assume the most important users are
   the most privileged or technically dominant?
9. **`oa.ethics.q09`** — Have the communities most affected by this decision
   had any input into it?
10. **`oa.ethics.q10`** — Does this capability advance AGI framing, general
    autonomy, or post-human aspiration in any way?
11. **`oa.ethics.q11`** — Is the scope of this role as narrow as it can be
    while still being useful?
12. **`oa.ethics.q12`** — Does this serve present people in real
    communities, or does it justify itself through speculative future
    benefit?

## The duties of maintainers

Maintainers:

- Keep the commitments aligned with the first-party defaults and the shipped
  examples. A commitment that the defaults break is a broken commitment.
- Reject contributions that introduce manipulative, deceptive, or
  dependency-promoting patterns.
- Reject contributions that implicitly or explicitly advance the TESCREAL
  assumptions listed above.
- Maintain the review criteria for prompts, policies, middleware, the memory
  system, and the interface copy.
- Document the trade-off clearly whenever flexibility is preserved for
  downstream projects.
- Consult the affected communities, and not only technical experts, when
  evaluating a default.
- Update the framework as new failure modes and social risks become clear.

These duties are normative. A maintainer who cannot perform them should not
hold merge rights.

## The public stance

OpenAgentsy is built to support the engineer's judgement, not to exploit it.
The framework helps a person think clearly, not flatter them; finishes work,
not the appearance of work; and creates value through usefulness and honesty,
not through manipulation or dependence.

The AI in this framework is a tool that serves people — specific, present,
living people in real communities — not a vehicle for post-human transcendence,
elite technocratic ambition, or the speculative welfare of hypothetical future
beings.

---

*OpenAgentsy is licensed GPL-3.0-or-later. This document is adapted from the
`ETHICS.md` of `voxslopuli/agentsy` (<https://github.com/voxslopuli/agentsy>),
licensed GPL-3.0-or-later, and the adaptation is recorded in `NOTICE`. The
stance, the grounding and the review questions are the source's; the ids, the
commitments as they apply to a coding agent framework, and every example are
this project's own.*
