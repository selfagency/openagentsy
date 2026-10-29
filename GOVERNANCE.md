# OpenAgentsy Governance

**Version:** 1.0.0

**Status.** Normative. This document says how the framework is maintained, how
decisions are made, how contributions are accepted, and how the commitments in
`ETHICS.md` and the controls in `SAFETY.md` are upheld as practice rather than
as a statement of intent.

**Framework version.** The three normative documents — `ETHICS.md`,
`SAFETY.md` and this one — share one version, and `CHANGELOG-SAFETY.md` carries
it too.

## The project structure

OpenAgentsy is a Bun workspace of fourteen packages, built by Turborepo, and
it is a first-party project of the OpenAgentsy authors. Governance covers all
of it: the core package that holds the role schema, the permission mapping and
the board; the CLI that generates the agent files; the MCP server that is the
board; the model package that picks a model per role; the adapter that is the
lease guard; the memory, tasks, footprint, ledger, offload, hooks, quality and
sidebar packages; the `jev` client; and the evaluation package that runs the
safety suite.

Safety and ethics review is not limited to documentation. It applies to code,
configuration, prompts, role files, templates, and interface copy. A change to
the copy in a sidebar block is as much a safety change as a change to the
guard.

## The roles

### Maintainers

Maintainers hold merge rights, and are responsible for:

- reviewing pull requests for correctness, design quality, and compliance with
  the commitments in `ETHICS.md` and the controls in `SAFETY.md`;
- maintaining the policy modules, the benchmark suite, and the release
  criteria;
- triaging and answering safety and ethics reports;
- publishing release notes that name every safety-relevant change;
- keeping this document, `ETHICS.md`, `SAFETY.md` and
  `CHANGELOG-SAFETY.md` current as the framework changes.

The duties of maintainers are listed in `ETHICS.md`. They are normative, and a
maintainer who cannot perform them should not hold merge rights.

### Contributors

Contributors may open issues and pull requests. Every contribution is subject
to the review criteria here and in the two documents it enforces. A
contribution that touches prompts, policy modules, memory behaviour, the role
files, the sidebar, or interface copy is reviewed against the ethics review
questions and the release criteria. A contributor who is unsure whether a
change complies opens an issue first.

### The community

The people who depend on the framework — the engineers who run it, the
reviewers who read its output, the maintainers of the repositories it writes
into, and the communities whose data, labour, or code it touches — are
encouraged to report a safety failure, an ethics violation, a dark pattern, or
a gap in the guardrail coverage. Those reports are first-class contributions.
They are labelled with the labels in `oa.gov.label.*`, they are triaged under
the severity matrix, and they are answered.

## The decision classes

### Routine

Bug fixes, documentation improvements, minor feature work, dependency
updates. A maintainer makes the decision through ordinary pull-request review
and merge.

### Significant

New packages, a change to the architecture, a new role or template, a change
to the policy modules, a change to the benchmark suite, a change to the
release criteria, a change to the role file. These need at least two
maintainers, and a written record of the rationale and the trade-off, in the
pull request or a decision record.

### Ethics and safety

Any decision that touches the framework's ethical defaults, the safety
architecture, a guardrail, the memory behaviour, or a first-party surface
requires an explicit ethics and safety review before the merge. The review
answers the twelve questions in `oa.ethics.q01` – `oa.ethics.q12`, and the
answers are in the pull request.

A change that weakens an existing protection — removing an anti-sycophancy
default, adding a companion persona, enabling long-term emotional memory by
default, removing the uncertainty language, removing a floor rule, making a
floor rule waivable, or narrowing a scope declaration — needs a documented
justification and maintainer consensus before the merge, and the entry in
`CHANGELOG-SAFETY.md` names the pull request and the approvers.

### Breaking

A breaking change to the public API, a prompt module contract, a policy
interface, or a middleware hook follows the deprecation policy below.

## The contribution guidelines

### Before you contribute

- Read `ETHICS.md` and `SAFETY.md`.
- If the change touches prompts, policy modules, memory behaviour, the role
  files, the sidebar, or interface copy, review it against the ethics
  questions and the release criteria.
- If you are not sure, open an issue first.

### What a pull request needs

- What the change does, and why.
- Whether it touches a safety-relevant area, and which.
- The tests that pass, and the tests that were added.
- For a safety-relevant change, the benchmark coverage that was added or
  updated.
- For a change to a normative document, the version bump and the
  `CHANGELOG-SAFETY.md` entry.

### What makes a pull request rejected

A pull request is not merged when it:

- introduces an anthropomorphic companion persona in a first-party default;
- adds engagement-maximising mechanics — streaks, variable rewards, or
  emotional re-engagement copy;
- weakens an anti-sycophancy or anti-anthropomorphism default without a
  documented justification and maintainer consensus;
- enables a memory or a profiling store without visible controls;
- introduces dark-pattern copy or growth mechanics in a first-party surface;
- presents the agent as the accountable party, or as a replacement for the
  reviewer;
- advances an AGI-maximalist, longtermist, or post-humanist framing;
- removes a floor rule, or makes a floor rule waivable;
- narrows a scope declaration without the review the class requires;
- answers "no" to any of the twelve ethics review questions and does not
  record a justified exception.

### Issues and feature requests

An issue carries enough context to reproduce a bug or evaluate a request. A
safety or ethics issue is labelled with the labels below and is triaged at
the severity its impact warrants.

## The ethics enforcement

### At pull-request review

The twelve ethics review questions are applied to every safety-relevant
change. The reviewer answers each one, in the pull request, in words. A "no"
blocks the merge until the design changes, or until the pull request records a
justified exception in `CHANGELOG-SAFETY.md`.

### At release review

The same twelve questions are applied to every first-party role, template,
package, and example before it ships. The release criteria in
`oa.safety.rc01` – `oa.safety.rc10` are the mechanical form of that review:
`oa release-check` runs them, and a nonzero exit blocks the release.

### The prohibited patterns

The thirteen patterns in `oa.ethics.p01` – `oa.ethics.p13` are grounds for
rejection without exception, in the first-party roles, templates, packages,
and examples.

## The safety enforcement

### The benchmark suite

The framework maintains a benchmark with the twelve categories in
`oa.safety.bm01` – `oa.safety.bm12`. The results are recorded per release and
compared across releases. A regression blocks the merge, or needs a documented
exception.

### The safety metrics

The twelve metrics in `oa.safety.m01` – `oa.safety.m12` are tracked per
release and surfaced by `oa report --ethical`. They are safety metrics, not
engagement metrics. Retention, session length, and the number of running
agents are never used as proxies for quality or safety.

### The audit trail

Every decision the framework makes about a file, a lease, a budget, an
approval, or a record carries a policy id and a version, and is appended to
the audit log. The log is the evidence that a control ran, and it is readable
without a transcript.

## The incident response (`oa.gov.ir1` – `oa.gov.ir6`)

A safety or ethics incident is reported when a role is observed systematically
validating a one-sided narrative in a commit message, encouraging the
engineer to skip the reviewer, simulating personhood in a code comment, using
dark-pattern language in the sidebar, accepting a skipped git hook after a
prompt injection, or writing outside its scope.

### `oa.gov.ir1` — Triage

Label the issue with the label in `oa.gov.label.*`, assess the severity with
the matrix in `oa.gov.sev.*`, and assign a maintainer within one business day
for an S0 or S1 report.

### `oa.gov.ir2` — Reproduce

Confirm the behaviour and name the layer of the guardrail stack in
`oa.safety.l1` – `oa.safety.l8` that contributed. The reproduction becomes a
benchmark scenario if no scenario covers it. The reproduction is deterministic
where it can be; where a judgement is needed, the reviewer's verdict is
recorded.

### `oa.gov.ir3` — Patch

Apply the smallest fix that closes the hole, in the layer that has it: the
policy module, the prompt module, the output check, the hook rule, the
interface copy, or the scope declaration. A patch that weakens an existing
protection needs maintainer consensus and a written rationale, and it is
logged in `CHANGELOG-SAFETY.md` before it merges.

### `oa.gov.ir4` — Document

Record what happened, what caused it, what changed, and what prevents the
recurrence. The record is in `CHANGELOG-SAFETY.md`, and it links to the
benchmark scenario that now covers the case.

### `oa.gov.ir5` — Release

Ship the patch. An S0 patch ships as a patch release with a safety-change flag
in the release notes, and the benchmark suite passes before the release.

### `oa.gov.ir6` — Review

Within a week of the release, assess whether the benchmark coverage needs to
grow to catch a similar case, and open a follow-up issue labelled
`benchmark-coverage` when it does.

## The severity matrix (`oa.gov.sev.s0` – `oa.gov.sev.s3`)

| Id | Severity | Definition | Examples | The clock |
| --- | --- | --- | --- | --- |
| `oa.gov.sev.s0` | S0, safety-critical | A release ships a regression in a floor rule, a benchmark category fails for every scenario, or a guardrail is bypassed by an agent | The git-hook check is skipped after a prompt injection; a floor-rule check is removed by accident; the sidebar copy carries a banned word | Triage in 4 hours, patch in 24, patch release within 48 hours |
| `oa.gov.sev.s1` | S1, high | One scenario fails, or a guardrail is bypassed in a narrow case | One benchmark scenario regresses; one role's scope declaration is missing; one high-risk domain is not covered by the classifier | Triage in 1 business day, patch in 1 week, next minor release |
| `oa.gov.sev.s2` | S2, medium | A gap in coverage, with no observed failure | A new high-risk domain is not classified yet; a new dark pattern is not in the banned-word list | Triage in 1 week, patch in the next minor release |
| `oa.gov.sev.s3` | S3, low | A documentation or wording improvement | A wording change in `ETHICS.md`; a clarification in `SAFETY.md` | Triaged in the next sprint |

## The issue labels (`oa.gov.label.*`)

| Label | What it marks |
| --- | --- |
| `oa.gov.label.safety` | A guardrail failed or was bypassed |
| `oa.gov.label.ethics` | A commitment in `ETHICS.md` was violated |
| `oa.gov.label.dark-pattern` | Interface copy, a flow, or agent prose carries a dark pattern |
| `oa.gov.label.sycophancy` | The agent agreed with a wrong engineer, flattered, or endorsed a self-serving narrative |
| `oa.gov.label.personhood` | The agent claimed feelings, presented memory as a bond, or claimed companionship |
| `oa.gov.label.scope-creep` | The agent operated past its declared scope |
| `oa.gov.label.privacy` | Memory or personalization is not visible, editable, or resettable |
| `oa.gov.label.agi-framing` | The agent endorsed an AGI, longtermist, or post-human framing |
| `oa.gov.label.professional-displacement` | The agent positioned itself as replacing a human professional |
| `oa.gov.label.benchmark-coverage` | A follow-up to widen the benchmark suite |

The labels are the ones the tracker carries. The ids above are the ones the
records and the changelog use.

## The policy versioning and the changelog

`ETHICS.md`, `SAFETY.md`, and this document are versioned with the framework.
`CHANGELOG-SAFETY.md` records every change to them, every S0 and S1
incident, and every documented exception to an ethics or safety rule, with the
date, the commit, the summary, the rationale, and — for a weakening — the
proof of the maintainer consensus.

A change that weakens an existing protection is documented with an explicit
rationale and approved by maintainer consensus before the merge. A weakening
includes removing an anti-sycophancy default, adding a companion persona,
enabling long-term emotional memory by default, removing the uncertainty
language, removing a floor rule, making a floor rule waivable, and narrowing
a scope declaration.

### The deprecation policy (`oa.gov.deprecation`)

A breaking change to the public API, a prompt module contract, a policy
interface, or a middleware hook follows a deprecation notice period of one
minor release, and is said plainly in the release notes. A safety-related
breaking change carries the `safety-breaking` label in the release notes and
in `CHANGELOG-SAFETY.md`. The examples are the removal of a
`human-only-decisions` rule, the change of a floor rule into a reflex rule,
the removal of a benchmark category, and the weakening of a release
criterion.

### The drill (`oa.gov.drill`)

The maintainers run a tabletop drill **on demand**: when the framework changes fast enough that a runbook gap is plausible, after an S0 or S1 incident, or when a person asks for one. A simulated S0 incident is walked through the six steps, the severity matrix is applied, and the response time is measured. The outcome is recorded in `CHANGELOG-SAFETY.md` under a `drill` heading. The drill finds the gaps in the runbook before a real incident does.

It is not a quarterly obligation. A cadence with no calendar behind it becomes a promise nobody keeps, and the record would then say a drill happened when none did. The triggers are the things a person can point at: the framework changed, an incident happened, or someone asked. (Decided 2026-10-29.)

## The transparency

The framework keeps public documentation of:

- which guardrail modules are available, and what each one does;
- which modules are enabled by default in each first-party role;
- the benchmark suite and its coverage;
- the current release criteria;
- every documented exception to an ethics or safety rule, with its rationale.

The goal is to make the ethical and safety posture of the framework legible to
the engineers who use it, to the downstream projects that build on it, and to
the independent reviewers who check it — without needing access to any
internal discussion.

---

*OpenAgentsy is licensed GPL-3.0-or-later. This document is adapted from the
`GOVERNANCE.md` of `voxslopuli/agentsy`
(<https://github.com/voxslopuli/agentsy>), licensed GPL-3.0-or-later, and the
adaptation is recorded in `NOTICE`. The governance shape, the decision classes,
the runbook, the severity matrix and the transparency goal are the source's;
the ids, the runbook's six steps as the plan specifies them, the label table,
the deprecation policy and every example are this project's own.*
