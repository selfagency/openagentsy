import { defineTool, type ToolDef } from '@openagentsy/adapter-opencode';
import { memoryToolNames } from '@openagentsy/core';
import { z } from 'zod';
import type { MemoryInbox } from './inbox.js';
import type { MemoryEntry } from './model.js';
import type { MemoryStore } from './store.js';

/**
 * The memory tools.
 *
 * Three tools: search, list, and the decision. The decision tool exists and
 * works, and the permission map is what keeps an agent from calling it: the
 * map denies `oa_memory_decide` to every role, so only a person, through
 * the command that will call this same code, decides what is kept.
 */

/**
 * The tool names, for the base-tool vocabulary.
 *
 * The list lives in core, with the other tool names, so that the vocabulary
 * which resolves a tool name back to its base name and the tools the
 * server offers are one list.
 */
export { memoryToolNames };

/** The most results a search may return. */
export const MAX_SEARCH_LIMIT = 8;

/** The results a search returns when the caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** The most entries a list may return. */
export const MAX_LIST_LIMIT = 20;

/** The entries a list returns when the caller names no limit. */
export const DEFAULT_LIST_LIMIT = 10;

/** What the tools need. */
export type MemoryToolDeps = {
  store: MemoryStore;
  inbox: MemoryInbox;
};

/**
 * A memory, as a tool returns it.
 *
 * An unverified memory is redacted: the text becomes a marker that names
 * the id, so the caller can ask for it again and say so. The rest of the
 * entry stays, because what a memory is about is not a secret and a caller
 * that cannot see the category cannot ask for the category.
 */
export type MemoryHit = {
  id: string;
  text: string;
  category: string;
  source: string;
  confidence: string;
  created_at: string;
  verified: boolean;
};

const searchArgs = z.object({
  q: z.string().min(1),
  category: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  ordering: z.enum(['relevance', 'recency', 'lost-in-the-middle']).optional(),
  includeUnverified: z.boolean().optional(),
});

const listArgs = z.object({
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
});

const decideArgs = z.object({
  recordId: z.number().int(),
  decision: z.enum(['approve', 'reject']),
  decidedBy: z.string().min(1),
});

/** The three tools, each with the shape of its own arguments. */
export type MemoryTools = {
  oa_memory_search: ToolDef<typeof searchArgs>;
  oa_memory_list: ToolDef<typeof listArgs>;
  oa_memory_decide: ToolDef<typeof decideArgs>;
};

/**
 * The three tools, defined once.
 *
 * The definitions are handed to the two runtimes through the adapter's
 * helper, so the shape is the same in both OpenCode versions.
 */
export function createMemoryTools(deps: MemoryToolDeps): MemoryTools {
  return {
    oa_memory_search: defineTool({
      description:
        'Search the memories a person decided to keep. Substring and keyword over the text and the category. Unverified memories are redacted unless includeUnverified is set.',
      args: searchArgs,
      async execute(args) {
        const includeUnverified = args.includeUnverified ?? false;
        const results = await deps.store.search({
          q: args.q,
          ...(args.category === undefined ? {} : { category: args.category }),
          limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
          ordering: args.ordering ?? 'lost-in-the-middle',
        });
        return {
          hits: results.map((result) => hit(result.entry, includeUnverified)),
          total: results.length,
        };
      },
    }),

    oa_memory_list: defineTool({
      description: 'The most recent memories, and how many candidates are waiting for a decision.',
      args: listArgs,
      async execute(args) {
        const entries = await deps.store.entries();
        const recent = [...entries]
          .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
          .slice(0, args.limit ?? DEFAULT_LIST_LIMIT);
        const pending = await deps.inbox.pending();
        return {
          entries: recent.map((entry) => hit(entry, false)),
          pending: pending.length,
        };
      },
    }),

    oa_memory_decide: defineTool({
      description:
        'Decide on a candidate memory: approve it into the store, or reject it. A person decides, and the permission map keeps an agent from calling this.',
      args: decideArgs,
      async execute(args) {
        return deps.inbox.decide(args.recordId, args.decision, args.decidedBy);
      },
    }),
  };
}

/**
 * The shape a memory takes in a result.
 *
 * The text of an unverified memory is replaced by a marker that names it,
 * unless the caller asked for the unverified ones.
 */
function hit(entry: MemoryEntry, includeUnverified: boolean): MemoryHit {
  return {
    id: entry.id,
    text: entry.verified || includeUnverified ? entry.text : `[unverified: ${entry.id}]`,
    category: entry.category,
    source: entry.source,
    confidence: entry.confidence,
    created_at: entry.created_at,
    verified: entry.verified,
  };
}
