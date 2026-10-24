import { z } from 'zod';

/**
 * The answers a System One model returns.
 *
 * A System One model does not write prose. It answers typed questions, and
 * every answer is one of three shapes: a choice with a probability for each
 * option, a score with a probability for each level, or a noul, which is the
 * probability that a statement is true.
 *
 * The schemas are the contract with the API. An answer that does not fit is
 * an error, not a value to be used.
 */

export const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  /** The option with the highest probability. */
  choice: z.string(),
  /** How sure the model is, from 0 to 1. */
  confidence: z.number(),
  /** The probability of each option, keyed by its name. */
  probabilities: z.record(z.string(), z.number()),
});

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  /** The probability that the statement is true, from 0 to 1. */
  noul: z.number(),
});

export const scoreAnswerSchema = z.object({
  type: z.literal('score'),
  /** The probability weighted average of the levels. */
  score: z.number(),
  confidence: z.number(),
  /** The levels that were asked about, mapped to their level number. */
  legend: z.record(z.string(), z.number()),
  /** The probability of each level, keyed by its name. */
  probabilities: z.record(z.string(), z.number()),
});

export const systemOneAnswerSchema = choiceAnswerSchema.or(noulAnswerSchema).or(scoreAnswerSchema);

export const systemOneResponseSchema = z.object({
  /** The model that answered, which may differ from the alias that was asked for. */
  model: z.string(),
  /** The answers, keyed by the question names that were sent. */
  answers: z.record(z.string(), systemOneAnswerSchema),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
export type NoulAnswer = z.infer<typeof noulAnswerSchema>;
export type ScoreAnswer = z.infer<typeof scoreAnswerSchema>;
export type SystemOneAnswer = z.infer<typeof systemOneAnswerSchema>;
export type SystemOneResponse = z.infer<typeof systemOneResponseSchema>;

/**
 * A question, in the shape the API takes it.
 *
 * A noul asks whether a statement is true. A choice picks one option out of
 * a set, and the set is the criteria. A score rates the state against
 * ordered levels.
 */
export type NoulQuestion = {
  type: 'noul';
  instructions: string;
};

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  /** The options, each with a description of what it covers. */
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: 'score';
  instructions: string;
  /** The levels, from the lowest to the highest. */
  criteria: string[];
};

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** The state a question is asked about. */
export type JevState = string | Record<string, unknown> | unknown[];

export type SystemOneRequest = {
  /** The model, an alias or a versioned id. */
  model: string;
  state: JevState;
  /** The questions, keyed by a name the answer comes back under. */
  questions: Record<string, JevQuestion>;
};
