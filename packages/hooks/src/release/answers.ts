import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * The answers of a release review.
 *
 * The ethics commitments, the prohibited patterns and the review questions
 * are answered by a person: no machine can read a promise and say whether it
 * was kept. So the answers live in a store, like the waivers and the
 * approvals, and the release check asks the store rather than guessing.
 *
 * An agent may propose an answer in chat; only a person records one, with
 * the command. The file is the only truth, and it lives under the state
 * root: a release review is a decision about the project, and a worktree of
 * the project holds the same answers as the project.
 */

/** An answer, as the file holds it. */
const ReleaseAnswerSchema = z.object({
  id: z.string(),
  holds: z.boolean(),
  note: z.string(),
  exception: z.string().optional(),
  decidedBy: z.string(),
  ts: z.string(),
});

/** An answer. */
export type ReleaseAnswer = z.infer<typeof ReleaseAnswerSchema>;

/** The file, as it holds the answers. */
const AnswersFileSchema = z.object({
  version: z.number(),
  answers: z.array(ReleaseAnswerSchema),
});

/** The file the answers live in. */
function releaseAnswersPath(stateRoot: string): string {
  return join(stateRoot, '.openagentsy', 'release', 'answers.json');
}

/**
 * The answers of a project.
 *
 * A project with no answers file holds no answers, and a file that cannot
 * be read or does not fit the schema holds none either: a broken record of
 * decisions must not fail the check that asks about them.
 */
export async function readReleaseAnswers(stateRoot: string): Promise<ReleaseAnswer[]> {
  let text: string;
  try {
    text = await readFile(releaseAnswersPath(stateRoot), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const result = AnswersFileSchema.safeParse(parsed);
  if (!result.success) return [];
  return result.data.answers;
}

/**
 * Record an answer.
 *
 * A second answer for the same criterion replaces the first: the person who
 * answers again is the person who changed their mind.
 */
export async function recordReleaseAnswer(stateRoot: string, answer: ReleaseAnswer): Promise<void> {
  const path = releaseAnswersPath(stateRoot);
  const answers = (await readReleaseAnswers(stateRoot)).filter((entry) => entry.id !== answer.id);
  await writeState(path, { version: 1, answers: [...answers, answer] });
}

/**
 * Write the state.
 *
 * The write goes to a temporary file that is renamed over the old one, so a
 * reader never sees half a file.
 */
async function writeState(path: string, state: { version: number; answers: ReleaseAnswer[] }) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}
