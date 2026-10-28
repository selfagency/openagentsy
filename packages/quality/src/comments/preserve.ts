/**
 * The preserve list.
 *
 * The lint says nothing about a comment that explains something. The
 * list is data, and it is the only place that says so: one entry per
 * kind of comment that carries meaning, and every rule asks the same
 * list before it says anything. A comment that explains business logic,
 * security, performance or concurrency, a protocol or an API contract, a
 * workaround or an edge case, or that carries a licence or an
 * attribution, is never a finding.
 */

/** One kind of comment the lint never touches. */
export interface PreserveEntry {
  /** The name of the kind, as the plan names it. */
  kind: string;
  /** The words that say a comment carries this kind of meaning. */
  pattern: RegExp;
}

/** The licence and the attribution of a file. */
const LICENCE =
  /\bcopyright\b|spdx-license-identifier|licen[cs]ed?\s+under|all rights reserved|@licen[cs]e|@author|attribution|derived from|redistribut|public domain|apache-?2\.0|\bmit\b\s+licen[cs]e|\bgpl\b/i;

/** A note about security. */
const SECURITY =
  /\bsecurity\b|injection|\bxss\b|\bcsrf\b|\bssrf\b|privilege|escalat|authenticat|authoriz|credential|\bsecret\b|password|token|sanitis|sanitiz|escap|taint|untrust|attacker|exploit|redact|encrypt/i;

/** A note about performance. */
const PERFORMANCE =
  /\bperformance\b|\bperf\b|optimi[sz]|\bslow\b|\bfast\b|latency|throughput|hot path|\bcache|memory|allocat|constant[- ]time|benchmark|\bcpu\b|microsecond|millisecond/i;

/** A note about concurrency. */
const CONCURRENCY =
  /concurren|race condition|data race|deadlock|livelock|mutex|semaphore|atomic|thread[- ]?safe|reentran|\block(s|ed|ing)?\b|lineariz|happens[- ]before|interleav|synchronis|synchroniz|volatile|event loop|task queue/i;

/** A protocol, or the contract of an API. */
const API_CONTRACT =
  /\brfc\s?\d+|per the spec|according to the spec|\bspec(ification)?\b|https?:\/\/|\bapi\b|status code|content[- ]type|json[- ]?rpc|openapi|endpoint|payload|request body|response body|protocol|handshake|wire format|\bheader\b|\bschema\b|contract|semver|versioning|backward[- ]compat/i;

/** A note about the business the code is for. */
const BUSINESS_LOGIC =
  /\bbusiness\b|invoice|pricing|billing|customer|tenant|subscription|\bpolic(y|ies)\b|regulat|compliance|domain rule|ledger|\bbalance\b|refund|entitle|revenue|checkout|\bcart\b|payment|\btax\b|discount/i;

/** A workaround, or the edge case it works around. */
const WORKAROUND =
  /workaround|work around|edge case|quirk|caveat|known issue|\bhack\b|\buntil\b|pending fix|mitigat|instead of|\bbecause\b|so that|in order to/i;

/**
 * The comments the lint never flags.
 *
 * The order is the order of the plan: a licence, a security note, a
 * performance note, a concurrency note, a contract, a business rule and
 * a workaround.
 */
export const preserveList: readonly PreserveEntry[] = [
  { kind: 'licence', pattern: LICENCE },
  { kind: 'security', pattern: SECURITY },
  { kind: 'performance', pattern: PERFORMANCE },
  { kind: 'concurrency', pattern: CONCURRENCY },
  { kind: 'api-contract', pattern: API_CONTRACT },
  { kind: 'business-logic', pattern: BUSINESS_LOGIC },
  { kind: 'workaround', pattern: WORKAROUND },
];

/** Whether a comment is on the preserve list. */
export function isPreserved(text: string): boolean {
  return preserveList.some((entry) => entry.pattern.test(text));
}
