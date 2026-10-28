import { z } from 'zod';
import { offload } from './router.js';
import type { LocalBackend, OffloadUsage } from './types.js';

/**
 * The five housekeeping jobs of the plan (§9.1). Each one is a prompt, a
 * schema and a token budget; the router does the rest. A job that cannot be
 * answered comes back as `undefined` and the caller falls back.
 */

/** A title for a session or a task. */
export const titleSchema = z.object({ title: z.string().max(60) });
export type TitleResult = z.infer<typeof titleSchema>;

/** The draft of a compacted context, and the facts that must survive it. */
export const compactionSummarySchema = z.object({
  summary: z.string().max(1200),
  keep: z.array(z.string()),
});
export type CompactionSummary = z.infer<typeof compactionSummarySchema>;

/** A quick reply is short enough to read at a glance. */
const replySchema = z
  .string()
  .refine(
    (reply) => reply.trim().split(/\s+/).filter(Boolean).length <= 10,
    'a quick reply is at most ten words',
  );

export const quickRepliesSchema = z.object({ replies: z.array(replySchema).max(4) });
export type QuickReplies = z.infer<typeof quickRepliesSchema>;

const TITLE_TOKENS = 64;
const SUMMARY_TOKENS = 1_400;
const REPAIR_TOKENS = 1_024;
const CLASSIFY_TOKENS = 32;
const REPLY_TOKENS = 128;

/** The prompt every job sends: the instruction, the shape, and the input. */
function prompt(instruction: string, input: string, schema: unknown): string {
  return [
    instruction,
    '',
    'Answer with one JSON object and nothing else. It must match this JSON schema:',
    JSON.stringify(schema),
    '',
    'Input:',
    input,
  ].join('\n');
}

/** A short title for the text. */
export async function titleFor(
  text: string,
  be: LocalBackend,
  onUsage: (usage: OffloadUsage) => void,
): Promise<TitleResult | undefined> {
  return offload(
    {
      name: 'title',
      prompt: prompt(
        'Write a short title for the text below. The title is at most 60 characters.',
        text,
        z.toJSONSchema(titleSchema),
      ),
      schema: titleSchema,
      maxTokens: TITLE_TOKENS,
    },
    be,
    onUsage,
  );
}

/** A draft of the compacted context, with the facts to keep beside it. */
export async function compactionSummary(
  context: string,
  be: LocalBackend,
  onUsage: (usage: OffloadUsage) => void,
): Promise<CompactionSummary | undefined> {
  return offload(
    {
      name: 'compaction-summary',
      prompt: prompt(
        'Summarize the context below in at most 1200 characters, and list the facts that must be kept.',
        context,
        z.toJSONSchema(compactionSummarySchema),
      ),
      schema: compactionSummarySchema,
      maxTokens: SUMMARY_TOKENS,
    },
    be,
    onUsage,
  );
}

/** Tool arguments that do not parse, repaired into the target schema. */
export async function repairToolArguments<T>(
  text: string,
  schema: z.ZodType<T>,
  be: LocalBackend,
  onUsage: (usage: OffloadUsage) => void,
): Promise<T | undefined> {
  return offload(
    {
      name: 'repair-tool-arguments',
      prompt: prompt(
        'Repair the tool arguments below into valid JSON that matches the schema.',
        text,
        z.toJSONSchema(schema),
      ),
      schema,
      maxTokens: REPAIR_TOKENS,
    },
    be,
    onUsage,
  );
}

/** The one value out of the given ones that fits the text. */
export async function classify<T extends string>(
  text: string,
  values: readonly [T, ...T[]],
  be: LocalBackend,
  onUsage: (usage: OffloadUsage) => void,
): Promise<T | undefined> {
  const schema = z.object({ label: z.enum(values) });
  const result = await offload(
    {
      name: 'classify',
      prompt: prompt(
        `Classify the text below as exactly one of: ${values.join(', ')}.`,
        text,
        z.toJSONSchema(schema),
      ),
      schema,
      maxTokens: CLASSIFY_TOKENS,
    },
    be,
    onUsage,
  );
  return result?.label;
}

/** Up to four short replies to the turn. */
export async function quickReplies(
  turn: string,
  be: LocalBackend,
  onUsage: (usage: OffloadUsage) => void,
): Promise<QuickReplies | undefined> {
  return offload(
    {
      name: 'quick-replies',
      prompt: prompt(
        'Write up to four short replies to the turn below. Each reply is at most ten words.',
        turn,
        z.toJSONSchema(quickRepliesSchema),
      ),
      schema: quickRepliesSchema,
      maxTokens: REPLY_TOKENS,
    },
    be,
    onUsage,
  );
}
