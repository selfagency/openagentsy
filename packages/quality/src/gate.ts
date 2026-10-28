import { z } from 'zod';
import { check } from './check.js';
import type { CheckCtx, Finding, QualityRegistry } from './rule.js';

/**
 * The reviewer gate.
 *
 * A review is a claim: the reviewer says the change is good. The gate does
 * not take the claim for an answer. It reads the verdict and the findings
 * that are open, and a verdict of ship with an open floor finding is refused
 * as a fabricated pass: the reviewer said yes to something the rules still
 * hold wrong.
 *
 * The decision is a function of its input and of nothing else. The files
 * are read by the caller, the waivers are read by the caller, and what
 * arrives here is the verdict, the findings and the lookup. So the same
 * gate is decided the same way twice, and a test of it needs no disk.
 */

/** A finding, as the gate carries it. */
export const FindingSchema = z.object({
  ruleId: z.string(),
  source: z.string(),
  tier: z.enum(['floor', 'reflex', 'finish']),
  file: z.string(),
  line: z.number(),
  message: z.string(),
  fix: z.string(),
  kind: z.enum(['claim']).optional(),
});

/**
 * The words a verdict is written in.
 *
 * A reviewer says "ship" or "approve", and it says "fix" or "not yet". The
 * gate reads the word it was given and acts on the three verdicts those
 * words stand for.
 */
export const VERDICTS = ['ship', 'approve', 'fix', 'not yet', 'rebuild'] as const;

/** The verdict, as the three the gate acts on. */
export type GateVerdict = 'ship' | 'fix' | 'rebuild';

/** The verdict each word stands for. */
const VERDICT_OF: Record<(typeof VERDICTS)[number], GateVerdict> = {
  ship: 'ship',
  approve: 'ship',
  fix: 'fix',
  'not yet': 'fix',
  rebuild: 'rebuild',
};

/**
 * The verdict, as the reviewer writes it.
 *
 * The words are read as they are written, so a verdict in capitals is the
 * same verdict as one in small letters.
 */
const VerdictSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.enum(VERDICTS),
);

/**
 * The gate, as the reviewer returns it.
 *
 * The reviewer returns its verdict, the findings it saw, the techniques it
 * judged and the dials it read. All of it is carried, and only the verdict
 * and the open findings decide: the reviewer's own list of findings is a
 * claim like any other, and the files are the truth.
 */
export const ReviewGate = z.object({
  /** The floor findings the reviewer saw. */
  floor: z.array(FindingSchema).default([]),
  /** The reflex findings the reviewer saw, and what became of them. */
  reflex: z
    .array(
      z.object({
        finding: FindingSchema,
        status: z.enum(['fixed', 'waived', 'open']),
      }),
    )
    .default([]),
  /** The techniques the change uses, and what each one serves. */
  purpose: z.array(z.object({ technique: z.string(), reason: z.string() })).default([]),
  /** The dials the reviewer read. */
  liveliness: z
    .object({
      energy: z.number().min(0).max(10),
      rhythm: z.number().min(0).max(10),
      motion: z.number().min(0).max(10),
      note: z.string(),
    })
    .optional(),
  /** The verdict. */
  verdict: VerdictSchema,
});

/** A review, as the gate carries it. */
export type Review = z.infer<typeof ReviewGate>;

/**
 * The seam the waivers of a project reach the gate through.
 *
 * The waiver store lives in the hooks package, and the hooks package sits
 * above the quality package, so the quality package cannot import it and
 * the gate cannot read the file of decisions itself. The gate asks a
 * question instead: does a waiver cover this finding? The store's own
 * lookup answers exactly that, so it satisfies this shape and the two
 * packages never depend on each other.
 */
export interface WaiverLookup {
  /** Whether a waiver covers a finding. */
  covers(finding: Finding): boolean;
}

/** The lookup that covers nothing. */
export const noWaivers: WaiverLookup = { covers: () => false };

/** Why the gate refused a review. */
export type GateRefusal = 'fabricated-pass' | 'invalid-gate';

/** What the gate decided. */
export interface GateResult {
  /** Whether the gate accepted the review. */
  accepted: boolean;
  /** The verdict, as the three the gate acts on. */
  verdict: GateVerdict;
  /** Why the gate refused, when it refused. */
  reason?: GateRefusal;
  /** The floor findings that are open. */
  openFloor: Finding[];
  /** The reflex findings that are open. */
  openReflex: Finding[];
  /** True when a ship was accepted with reflex findings still open. */
  shippedWithOpenReflex: boolean;
  /** The review, when it parsed. */
  review?: Review;
}

/** What the gate decides on. */
export interface GateInput {
  /** What the reviewer returned. */
  raw: unknown;
  /** The findings of the re-run check. */
  findings: readonly Finding[];
  /** The waivers that cover a finding. */
  waivers?: WaiverLookup;
}

/**
 * The decision.
 *
 * A ship verdict with an open floor finding is a fabricated pass, and it is
 * refused as one. A ship verdict with only reflex findings open is
 * accepted, and the result says that it was accepted with them open. A
 * verdict that asks for work is a refusal, and a refusal is accepted: the
 * gate does not ship anything on it.
 */
export function acceptGate(input: GateInput): GateResult {
  const parsed = ReviewGate.safeParse(input.raw);
  if (!parsed.success) return refused('invalid-gate');
  const review = parsed.data;
  const verdict = VERDICT_OF[review.verdict];
  const waivers = input.waivers ?? noWaivers;
  const open = input.findings.filter((finding) => !waivers.covers(finding));
  const openFloor = open.filter((finding) => finding.tier === 'floor');
  const openReflex = open.filter((finding) => finding.tier === 'reflex');
  if (verdict === 'ship' && openFloor.length > 0) {
    return {
      accepted: false,
      verdict,
      reason: 'fabricated-pass',
      openFloor,
      openReflex,
      shippedWithOpenReflex: false,
      review,
    };
  }
  return {
    accepted: true,
    verdict,
    openFloor,
    openReflex,
    shippedWithOpenReflex: verdict === 'ship' && openReflex.length > 0,
    review,
  };
}

/**
 * The refusal.
 *
 * A gate that does not parse is a refusal as well, and nothing shipped, so
 * the verdict of it is the one that asks for work.
 */
function refused(reason: GateRefusal): GateResult {
  return {
    accepted: false,
    verdict: 'fix',
    reason,
    openFloor: [],
    openReflex: [],
    shippedWithOpenReflex: false,
  };
}

/** What a review needs beside the verdict. */
export interface GateReview {
  /** What the reviewer returned. */
  raw: unknown;
  /** The files the change touched. */
  files: readonly string[];
  /** The root the files are read from. */
  root?: string;
  /** The waivers that cover a finding. */
  waivers?: WaiverLookup;
  /** The context of the check. */
  ctx?: CheckCtx;
  /** The rules the check runs. */
  registry?: QualityRegistry;
}

/**
 * The review of a change.
 *
 * The check runs again here, because the reviewer's own pass is a claim and
 * the files are the truth. What the gate decides on is the findings of the
 * re-run, and the waivers are the decisions of people about those findings.
 */
export async function reviewGate(review: GateReview): Promise<GateResult> {
  const findings = await check(review.files, review.ctx ?? {}, {
    ...(review.root !== undefined ? { root: review.root } : {}),
    ...(review.registry !== undefined ? { registry: review.registry } : {}),
  });
  return acceptGate({
    raw: review.raw,
    findings,
    ...(review.waivers !== undefined ? { waivers: review.waivers } : {}),
  });
}
