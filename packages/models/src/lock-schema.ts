import { z } from 'zod';

/**
 * The lock file, as the shape it has on disk.
 *
 * The lock is a contract between three packages: the model selector writes
 * it, the CLI reads it to build the agents, and the plugin reads it to climb
 * the effort ladder. A second copy of the type drifts, and a drift is a
 * field that disappears for one of them without a word.
 *
 * The schema is the definition. The type is read out of it, so a file that
 * does not fit the schema is a file nobody reads.
 */
export const modelLockEntrySchema = z.object({
  model: z.string(),
  runnerUp: z.string().optional(),
  evidence: z
    .object({
      source: z.string(),
      label: z.string().optional(),
      surface: z.string().optional(),
      rank: z.number().optional(),
      score: z.number().optional(),
      date: z.string().optional(),
    })
    .optional(),
  date: z.string().optional(),
  ladder: z.array(z.object({ model: z.string(), variant: z.string().optional() })),
});

export const modelLockSchema = z.object({
  generatedAt: z.string(),
  /** The providers the lock names. Older locks do not have it. */
  providers: z.array(z.string()).optional(),
  roles: z.record(z.string(), modelLockEntrySchema),
});

export type ModelLockEntry = z.infer<typeof modelLockEntrySchema>;
export type ModelLock = z.infer<typeof modelLockSchema>;
