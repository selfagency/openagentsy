# Changelog (safety and ethics)

**Version:** 1.0.0

**Status.** Normative. This is the record the framework's ethics and safety
commitments are held to. `ETHICS.md`, `SAFETY.md` and `GOVERNANCE.md` are
versioned with the framework, and this file is the history of that version:
what changed, why, and who agreed.

**Framework version.** The three normative documents and this file share one
version. A change to any of them bumps it, and the bump is recorded here.

## What is logged here

- Every change to `ETHICS.md`, `SAFETY.md` or `GOVERNANCE.md`.
- Every S0 and S1 incident, under `oa.gov.ir1` – `oa.gov.ir6`.
- Every documented exception to an ethics or safety rule, including the
  exception the ethics review questions allow a pull request to record.
- Every drill, under `drill`.
- Every safety-related breaking change, flagged `safety-breaking`.

## The format of an entry

An entry carries a date, the commit, a summary, and the rationale. A change
that weakens an existing protection also carries the proof of the maintainer
consensus: the pull request and the approvers.

A weakening is any of these:

- removing an anti-sycophancy default;
- adding a companion persona;
- enabling long-term emotional memory by default;
- removing the uncertainty language;
- removing a floor rule;
- making a floor rule waivable;
- narrowing a scope declaration.

A weakening is documented with an explicit rationale and approved by
maintainer consensus before it merges. An entry without that proof is an
incomplete entry, and the change is not done.

## 1.0.0 - 2026-10-28

The framework version 1.0.0: the first-party ethics, safety and governance
documents, and the changelog that holds them to account.

### Added

| Date | Commit | Summary | Rationale |
| --- | --- | --- | --- |
| 2026-10-28 | `feature/2f-1a-first-party-docs` — the commit that added this file | `ETHICS.md`, `SAFETY.md` and `GOVERNANCE.md` at the repository root, carrying the framework's normative commitments, controls and process | The plan (revision 3, §17) moved the ethics-relevant rules out of scattered sections and into three documents that are versioned with the framework. The documents are adapted from `voxslopuli/agentsy`'s `ETHICS.md`, `SAFETY.md` and `GOVERNANCE.md`, translated from a general-purpose assistant's domain to a coding agent framework's: over-trust in agent-generated code, the displacement of the reviewer, scope creep from code into prose and policy, dark patterns in the sidebar, and hidden memory of a project's behaviour |
| 2026-10-28 | as above | The policy ids: `oa.ethics.c01` – `oa.ethics.c12` (the commitments), `oa.ethics.p01` – `oa.ethics.p13` (the prohibited patterns), `oa.ethics.q01` – `oa.ethics.q12` (the review questions), `oa.ethics.t01` – `oa.ethics.t06` (the TESCREAL oppositions), `oa.safety.l1` – `oa.safety.l8` (the guardrail layers), `oa.safety.b01` – `oa.safety.b09` (the behavioural rules), `oa.safety.bm01` – `oa.safety.bm12` (the benchmark categories), `oa.safety.m01` – `oa.safety.m12` (the safety metrics), `oa.safety.rc01` – `oa.safety.rc10` (the release criteria), `oa.gov.ir1` – `oa.gov.ir6` (the incident runbook), `oa.gov.sev.s0` – `oa.gov.sev.s3` (the severities), `oa.gov.label.*` (the issue labels), `oa.gov.deprecation` and `oa.gov.drill` | The rest of step 2f keys off these ids: the policy module library uses them, the benchmark suite names its categories with them, `oa release-check` checks its criteria against them, and the incident runbook records them. An id that no rule carries is an id nobody can trace |
| 2026-10-28 | as above | `oa doctor` reports the presence and the version of the four documents | The plan's exit test for step 2f asks for it. A document that is not there is a finding, not a crash, and a version that disagrees with the others is a partially applied bump |

### Changed

Nothing. This is the first entry, and no protection was removed, narrowed, or
made waivable.

### Weakened

Nothing. No weakening is recorded, and no weakening is permitted without the
proof above: the pull request and the approvers.

### Exceptions

None. No ethics or safety rule has an exception against it.

### Incidents

None recorded. The incident runbook is documented in `GOVERNANCE.md`; the
first entry here will be an incident.

### drill

No drill has been run yet. The plan asks for a tabletop drill of an S0
incident, and its outcome is recorded here.

**When a drill runs** (decided 2026-10-29): on demand — when the framework
changes fast enough that a runbook gap is plausible, after an S0 or S1
incident, or when a person asks for one. It is not a quarterly obligation:
a cadence with no calendar behind it becomes a promise nobody keeps, and
the record would then claim a drill happened when none did. The drill's
outcome goes under this heading, with the date, the scenario, the severity
the matrix assigned, the response time measured, and the gaps the runbook
turned out to have.

## The record ahead

Every entry above this line is the framework's history. Every entry below it
is a promise: the drill that has not run, the incident that has not happened,
the exception that has not been granted.
