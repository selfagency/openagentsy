import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { etagOf, redact } from '@openagentsy/core';
import {
  createMemoryId,
  isMemoryEntry,
  isMemoryMarker,
  isValidCategory,
  MAX_TEXT_LENGTH,
  type MemoryConfidence,
  type MemoryEntry,
  type MemoryMarker,
  normalizeText,
} from './model.js';

/**
 * The memory store.
 *
 * One file, one JSON object per line, so `grep` and `wc -l` work on it. The
 * file lives at the state root (§3.9), which is the root of the project the
 * store is given: `.openagentsy/memory.jsonl`. The resolution of that root
 * from a worktree is a later phase, so the root is injected here and a test
 * passes a temporary directory.
 */

/** What a decision is audited with. */
export type MemoryAuditDetail = {
  /** The board record the decision was about. */
  recordId?: number;
  /** The memory the decision was about. */
  id?: string;
  /** Who decided. */
  decidedBy: string;
  /** The decision itself, for the inbox's decisions. */
  decision?: 'approve' | 'reject';
};

/** The audit sink a decision is written to. */
export type MemoryAuditSink = (policyId: string, detail: MemoryAuditDetail) => void | Promise<void>;

export type MemoryStoreOptions = {
  /** The state root. The file is `<root>/.openagentsy/memory.jsonl`. */
  root: string;
  /** The clock, so a test can pin the time. */
  now?: () => Date;
  /** Where a person-only change is audited. */
  onAudit?: MemoryAuditSink;
};

/** What a caller hands the store. */
export type AppendInput = {
  text: string;
  category: string;
  source: string;
  confidence: MemoryConfidence;
  /** Whether a person has already verified it. False unless said so. */
  verified?: boolean;
};

/** What the store did with an append. */
export type AppendOutcome =
  | { ok: true; entry: MemoryEntry; redactions: number }
  | { ok: false; reason: 'duplicate'; id: string; redactions: number }
  | { ok: false; reason: 'invalid'; detail: string; redactions: number };

/** How the results are ordered. */
export type MemoryOrdering = 'relevance' | 'recency' | 'lost-in-the-middle';

/** A search. */
export type MemoryQuery = {
  q: string;
  category?: string;
  limit?: number;
  ordering?: MemoryOrdering;
};

/** A result and the score that found it. */
export type ScoredMemory = {
  entry: MemoryEntry;
  score: number;
};

/** The parsed file: the entries and the markers, in the order they were written. */
type ParsedFile = {
  entries: MemoryEntry[];
  markers: MemoryMarker[];
  /** The dedup tag of every entry, by entry id. */
  tags: Map<string, string>;
};

/**
 * The store of what a person decided to keep.
 *
 * Append-only: an entry is written once and never changed. A person who
 * forgets or verifies a memory appends a marker instead, and the view this
 * class returns folds the markers into the entries. The file therefore only
 * ever grows, and a line in it is never rewritten.
 */
export class MemoryStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly onAudit: MemoryAuditSink | undefined;
  private cached: { key: string; file: ParsedFile } | undefined;

  constructor(options: MemoryStoreOptions) {
    this.root = options.root;
    this.now = options.now ?? (() => new Date());
    this.onAudit = options.onAudit;
  }

  /** The file the store lives in. */
  get path(): string {
    return join(this.root, '.openagentsy', 'memory.jsonl');
  }

  /**
   * Add a memory.
   *
   * The redaction runs first: nothing reaches the file that carries a
   * secret, and the count comes back with the outcome so the caller can
   * report it. A text that is already a duplicate is refused with the id of
   * the entry that holds it, because a memory that is already known is not
   * a new thing.
   */
  async append(input: AppendInput): Promise<AppendOutcome> {
    const redacted = redact(input.text);
    const redactions = redacted.count;
    const text = redacted.text.trim();

    if (text.length === 0) {
      return { ok: false, reason: 'invalid', detail: 'the text is empty', redactions };
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return {
        ok: false,
        reason: 'invalid',
        detail: `the text is longer than ${MAX_TEXT_LENGTH} characters`,
        redactions,
      };
    }
    if (!isValidCategory(input.category)) {
      return {
        ok: false,
        reason: 'invalid',
        detail: 'the category is not a tag: a lowercase word, words joined by single hyphens',
        redactions,
      };
    }

    const { entries, tags } = await this.read();
    const tag = etagOf(normalizeText(text));
    for (const entry of entries) {
      if (tags.get(entry.id) === tag) {
        return { ok: false, reason: 'duplicate', id: entry.id, redactions };
      }
    }

    const entry: MemoryEntry = {
      id: createMemoryId(),
      text,
      category: input.category,
      source: input.source,
      confidence: input.confidence,
      created_at: this.now().toISOString(),
      // A memory is trusted on write (the human's decision of 2026-10-28):
      // the archivist's judgement is the source, and a person marks a
      // memory unverified when they disagree. The flag is what the search
      // reads before anyone has said anything about the memory.
      verified: input.verified ?? true,
    };
    await this.appendLine(entry);
    return { ok: true, entry, redactions };
  }

  /** Every memory that is neither forgotten nor superseded. */
  async entries(): Promise<MemoryEntry[]> {
    const { entries, markers } = await this.read();
    const forgotten = new Set<string>();
    const verified = new Set<string>();
    for (const marker of markers) {
      if (marker.kind === 'forget') forgotten.add(marker.id);
      else verified.add(marker.id);
    }
    return entries
      .filter((entry) => !forgotten.has(entry.id))
      .map((entry) => (verified.has(entry.id) ? { ...entry, verified: true } : entry));
  }

  /**
   * Find the memories that mention the terms of a query.
   *
   * The store is small - a target of under ten thousand entries - so the
   * scan is over the parsed lines, and the parsed lines are cached against
   * the file's stat, so a search that follows a search reads the file once.
   */
  async search(query: MemoryQuery): Promise<ScoredMemory[]> {
    const entries = await this.entries();
    const terms = termsOf(query.q);
    const category = query.category?.toLowerCase();

    const scored = entries
      .filter((entry) => inCategory(entry, category))
      .map((entry) => ({ entry, score: scoreOf(entry, terms) }))
      .filter((result) => result.score > 0);

    const ordering = query.ordering ?? 'lost-in-the-middle';
    scored.sort(ordering === 'recency' ? byRecency : byRelevance);
    const top = query.limit === undefined ? scored : scored.slice(0, query.limit);
    return ordering === 'lost-in-the-middle' ? lostInTheMiddle(top) : top;
  }

  /**
   * Forget a memory.
   *
   * The entry stays in the file and the store stops returning it. The
   * removal command is a later phase; this is the path it will take, and
   * the person who did it is on the marker.
   */
  async forget(id: string, by: string = 'unknown'): Promise<boolean> {
    const { entries } = await this.read();
    if (!entries.some((entry) => entry.id === id)) return false;
    await this.appendLine({ kind: 'forget', id, by, at: this.now().toISOString() });
    await this.onAudit?.('oa.memory.forget', { id, decidedBy: by });
    return true;
  }

  /**
   * Mark a memory verified.
   *
   * A memory is trusted on write, and this is the other direction: a
   * person says it is true. The archivist's label is not a verification:
   * the archivist never looked at the memory.
   */
  async verify(id: string, decidedBy: string): Promise<boolean> {
    const { entries } = await this.read();
    if (!entries.some((entry) => entry.id === id)) return false;
    await this.appendLine({ kind: 'verify', id, by: decidedBy, at: this.now().toISOString() });
    await this.onAudit?.('oa.memory.verify', { id, decidedBy });
    return true;
  }

  /** Append one line to the file. */
  private async appendLine(line: MemoryEntry | MemoryMarker): Promise<void> {
    const path = this.path;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8');
  }

  /**
   * The parsed file, from the cache when the file has not changed.
   *
   * The key is the file's size and modification time, so a file that was
   * appended to misses the cache and a file that was not is read once.
   */
  private async read(): Promise<ParsedFile> {
    const path = this.path;
    let key: string;
    try {
      const info = await stat(path);
      key = `${info.mtimeMs}:${info.size}`;
    } catch {
      return { entries: [], markers: [], tags: new Map() };
    }
    if (this.cached?.key === key) return this.cached.file;

    const text = await readFile(path, 'utf8');
    const entries: MemoryEntry[] = [];
    const markers: MemoryMarker[] = [];
    const tags = new Map<string, string>();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (isMemoryEntry(parsed)) {
        entries.push(parsed);
        tags.set(parsed.id, etagOf(normalizeText(parsed.text)));
      } else if (isMemoryMarker(parsed)) {
        markers.push(parsed);
      }
    }
    const file: ParsedFile = { entries, markers, tags };
    this.cached = { key, file };
    return file;
  }
}

/** The terms of a query, lowercased. */
function termsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/** Whether an entry is in the category the query names. */
function inCategory(entry: MemoryEntry, category: string | undefined): boolean {
  return category === undefined || entry.category.toLowerCase() === category;
}

/**
 * The score of one entry against the terms of a query.
 *
 * A term in the text is worth more than a term in the category: the text is
 * what the memory says, and the category only says what it is about.
 */
function scoreOf(entry: MemoryEntry, terms: string[]): number {
  const text = entry.text.toLowerCase();
  const category = entry.category.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 2;
    if (category.includes(term)) score += 1;
  }
  return score;
}

/** The best match first, and the newest of two equals first. */
function byRelevance(a: ScoredMemory, b: ScoredMemory): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.entry.created_at !== b.entry.created_at) {
    return a.entry.created_at < b.entry.created_at ? 1 : -1;
  }
  return a.entry.id.localeCompare(b.entry.id);
}

/** The newest first. */
function byRecency(a: ScoredMemory, b: ScoredMemory): number {
  if (a.entry.created_at !== b.entry.created_at) {
    return a.entry.created_at < b.entry.created_at ? 1 : -1;
  }
  return a.entry.id.localeCompare(b.entry.id);
}

/**
 * The order that keeps the best results where a model looks first.
 *
 * A model attends to the start and the end of a context more than to the
 * middle, so the strongest result goes first and the second strongest goes
 * last, and the rest fill in between. The ranking is unchanged: only the
 * positions move.
 */
export function lostInTheMiddle<T>(ranked: readonly T[]): T[] {
  const front: T[] = [];
  const back: T[] = [];
  ranked.forEach((item, index) => {
    if (index % 2 === 0) front.push(item);
    else back.push(item);
  });
  return [...front, ...back.reverse()];
}
