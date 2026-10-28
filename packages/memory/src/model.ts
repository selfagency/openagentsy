import { nanoid } from 'nanoid';

/**
 * The memory slice's own vocabulary.
 *
 * A memory is what a person decided to keep. It is small on purpose: a
 * sentence, a tag, a source and a label. Everything else about the pipeline
 * - the candidates, the decisions, the audit - lives on the board, and this
 * package is only what survives a decision.
 */

/**
 * How sure the archivist was.
 *
 * The label travels with the memory, so a reader can tell a claim that was
 * checked from one that was inferred. It is not a verification: nobody has
 * looked at the memory, and `verified` says whether they have.
 */
export const MEMORY_CONFIDENCES = ['verified', 'inferred', 'guess'] as const;

export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

/**
 * One memory.
 *
 * The shape the plan gives it (§4.2), plus the verified flag the revision-3
 * fold adds (§4.8).
 */
export interface MemoryEntry {
  /** `oa-mem-<nanoid6>`. */
  id: string;
  /** At most 280 characters. Enforced on write. */
  text: string;
  /** A free-form tag: at most 24 characters, in the tasks TAG grammar. */
  category: string;
  /** `<recordId> · <bean|commit|file:line>` - where it came from. */
  source: string;
  /** The label the archivist gave the candidate. */
  confidence: MemoryConfidence;
  /** ISO 8601. */
  created_at: string;
  /**
   * Whether a person has verified this memory.
   *
   * It is false on append and stays false until a person marks it, because
   * approving a candidate and verifying it are two different acts. The
   * search redacts an unverified memory by default, so this flag decides
   * what an agent sees before anyone has said anything about it.
   */
  verified: boolean;
}

/**
 * A marker line.
 *
 * The store's file is append-only, so a person who forgets or verifies a
 * memory does not change the entry: the store appends a line that says what
 * happened, and the view the store returns folds the markers into the
 * entries. The entry itself is what the archivist said, and it stays that
 * way.
 */
export interface MemoryMarker {
  kind: 'forget' | 'verify';
  /** The id of the entry the marker is about. */
  id: string;
  /** Who did it. */
  by: string;
  /** ISO 8601. */
  at: string;
}

/** The longest text a memory may hold. */
export const MAX_TEXT_LENGTH = 280;

/** The longest category a memory may hold. */
export const MAX_CATEGORY_LENGTH = 24;

/**
 * The category grammar.
 *
 * The same grammar the task store uses for a tag: a lowercase word, and
 * words joined by single hyphens. A category that is not a tag is a
 * sentence, and a sentence is not a category.
 */
const CATEGORY_GRAMMAR = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The category a candidate gets when its record carries none. */
export const DEFAULT_CATEGORY = 'uncategorized';

/** The id of a memory: `oa-mem-<nanoid6>`. */
export function createMemoryId(): string {
  return `oa-mem-${nanoid(6)}`;
}

/** The text as the dedup sees it: lowercased, whitespace collapsed. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Whether a category is a tag. */
export function isValidCategory(category: string): boolean {
  return category.length <= MAX_CATEGORY_LENGTH && CATEGORY_GRAMMAR.test(category);
}

/** Whether a value is one of the three confidence labels. */
export function isMemoryConfidence(value: unknown): value is MemoryConfidence {
  return typeof value === 'string' && (MEMORY_CONFIDENCES as readonly string[]).includes(value);
}

/** Whether a value is a memory entry. */
export function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.text === 'string' &&
    typeof entry.category === 'string' &&
    typeof entry.source === 'string' &&
    typeof entry.created_at === 'string' &&
    typeof entry.verified === 'boolean' &&
    isMemoryConfidence(entry.confidence)
  );
}

/** Whether a value is a marker line. */
export function isMemoryMarker(value: unknown): value is MemoryMarker {
  if (typeof value !== 'object' || value === null) return false;
  const marker = value as Record<string, unknown>;
  return (
    (marker.kind === 'forget' || marker.kind === 'verify') &&
    typeof marker.id === 'string' &&
    typeof marker.by === 'string' &&
    typeof marker.at === 'string'
  );
}
