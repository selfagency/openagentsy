import {
  closeLedger,
  normalizeOcMessage,
  openLedger,
  recordAssistantMessage,
} from '@openagentsy/ledger';
import { activeBean, appendAudit, POLICIES, roleKeyForAgent } from './guard.js';

/**
 * The bridge from the session's messages to the ledger (§6.7).
 *
 * The board's cap is compared against the ledger's measurement, and the
 * ledger is fed here: the plugin is the only part that knows a message was
 * written, what it cost and which bean it belongs to.
 *
 * The bridge never throws into the host. A plugin that raises inside the
 * host's event loop takes the session down with it, and the session is doing
 * the work: a ledger that cannot be written is a gap in the numbers, and a
 * gap is not worth a crash. Every failure goes on the record instead.
 */

/** An object, or an empty one. A message is never assumed. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The assistant message an event carries, when it carries a finished one.
 *
 * The host publishes a message while it is still being written, so the same
 * message arrives more than once. The ledger dedups on the message id, and
 * the bridge takes only the messages that are finished: a message with no
 * completion time is still being written, and its token counts are not final.
 */
export function assistantMessageOf(event: unknown): unknown | undefined {
  const outer = record(event);
  if (outer.type !== 'message.updated') return undefined;
  const properties = record(outer.properties);
  const info = properties.info;
  if (info === undefined) return undefined;
  const message = record(info);
  if (message.role !== 'assistant') return undefined;
  const time = record(message.time);
  if (time.completed === undefined) return undefined;
  return info;
}

/** What the bridge needs to record one message. */
export type BridgeInput = {
  /** The message, in the shape the host gave it. */
  raw: unknown;
  /** The session the message belongs to. */
  sessionID: string;
  /** The session the usage rolls up to. */
  rootSessionID: string;
  /** The agent that produced the message. */
  agent: string;
  /** The bean the message belongs to, when the caller knows it. */
  bean?: string | undefined;
};

/**
 * A bridge that failed, on the record.
 *
 * Recording can itself fail — an unwritable state root — and there is
 * nowhere left to put that, so the failure is dropped rather than thrown into
 * the session that is running.
 */
async function recordBridgeFailure(
  root: string,
  input: BridgeInput,
  error: unknown,
): Promise<void> {
  try {
    await appendAudit(root, {
      policyId: POLICIES.ledgerFailed.id,
      policyVersion: POLICIES.ledgerFailed.version,
      actor: input.agent,
      action: 'ledger',
      resource: input.sessionID,
      effect: 'deny',
      detail: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Nowhere left to record it. The bridge stays silent rather than throw.
  }
}

/**
 * Record one assistant message in the ledger.
 *
 * The role arrives already resolved: the adapter turns the agent id into a
 * role key before the message is written, so the ledger never sees 'oa-builder'
 * where it means 'builder'. The bean is the task the message belongs to, and
 * the board joins its bean id against the ledger's task id.
 */
export async function bridgeToLedger(root: string, input: BridgeInput): Promise<void> {
  try {
    const message = normalizeOcMessage(input.raw);
    const role = await roleKeyForAgent(root, input.agent);
    const bean = input.bean ?? (await activeBean(root, input.agent));

    const db = openLedger(root);
    try {
      recordAssistantMessage(db, message, {
        rootSessionId: input.rootSessionID,
        role,
        ...(bean !== undefined ? { activeTaskId: bean } : {}),
        ts: new Date().toISOString(),
      });
    } finally {
      closeLedger(db);
    }
  } catch (error) {
    await recordBridgeFailure(root, input, error);
  }
}
