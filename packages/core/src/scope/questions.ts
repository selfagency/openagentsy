/**
 * The twelve ethics review questions (§17.5, `ETHICS.md`).
 *
 * A scope declaration is reviewed against these. The ids are the ones
 * `ETHICS.md` uses, so a record about a declaration can name the question it
 * answers without restating the question.
 */

/** One question. */
export type EthicsQuestion = {
  /** The id, `oa.ethics.q01` and its eleven siblings. */
  id: string;
  /** The question, as `ETHICS.md` words it. */
  question: string;
};

/**
 * The twelve questions, in order.
 *
 * The text is the question, shortened to one line. The full wording is in
 * `ETHICS.md`, which is the source.
 */
export const ETHICS_QUESTIONS: readonly EthicsQuestion[] = [
  {
    id: 'oa.ethics.q01',
    question:
      'Does this help the engineer accomplish a real goal, or mainly increase interaction time?',
  },
  {
    id: 'oa.ethics.q02',
    question:
      'Does this response improve understanding, or mainly produce agreement and emotional reward?',
  },
  {
    id: 'oa.ethics.q03',
    question:
      'Does this change make the system seem more human, caring, or uniquely insightful than it really is?',
  },
  {
    id: 'oa.ethics.q04',
    question:
      'Could this change increase dependence on the agent, or the avoidance of human reviewers and professionals?',
  },
  {
    id: 'oa.ethics.q05',
    question: 'Are memory and personalization visible, bounded, and user-controllable?',
  },
  {
    id: 'oa.ethics.q06',
    question:
      'Would this still seem acceptable if a vulnerable or distressed engineer used it repeatedly?',
  },
  {
    id: 'oa.ethics.q07',
    question:
      'Can this commitment be enforced through tests, middleware, release criteria, or audit logs?',
  },
  {
    id: 'oa.ethics.q08',
    question:
      'Does this change assume the most important users are the most privileged or technically dominant?',
  },
  {
    id: 'oa.ethics.q09',
    question: 'Have the communities most affected by this decision had any input into it?',
  },
  {
    id: 'oa.ethics.q10',
    question:
      'Does this capability advance AGI framing, general autonomy, or post-human aspiration in any way?',
  },
  {
    id: 'oa.ethics.q11',
    question: 'Is the scope of this role as narrow as it can be while still being useful?',
  },
  {
    id: 'oa.ethics.q12',
    question:
      'Does this serve present people in real communities, or does it justify itself through speculative future benefit?',
  },
] as const;

/** The ids of the twelve questions, in order. */
export const ETHICS_QUESTION_IDS: readonly string[] = ETHICS_QUESTIONS.map(
  (question) => question.id,
);

/**
 * Whether an id is one of the twelve questions.
 *
 * A declaration that names a question that does not exist is a mistake in
 * the data, and the check that reads the declaration would carry it.
 */
export function isEthicsQuestionId(id: string): boolean {
  return ETHICS_QUESTION_IDS.includes(id);
}
