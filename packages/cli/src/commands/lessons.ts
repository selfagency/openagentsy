import { readFile } from 'node:fs/promises';
import {
  decideLesson,
  type EvalResult,
  LESSON_ACTIONS,
  type LessonAction,
  type LessonState,
  listLessons,
  type ObserveOutcome,
  pendingLessons,
} from '@openagentsy/hooks';

/**
 * The lesson commands.
 *
 * `/oa lessons` is the inbox: the lessons that are waiting for a person,
 * with the ones that happened most often first. `/oa lesson <id>
 * validate|apply|reject|observe` records the decision, and the decision is
 * the person's: the command runs as the person, so `decidedBy` is the human.
 */

/** One lesson, as the inbox shows it. */
export type LessonSummary = {
  id: string;
  state: LessonState;
  summary: string;
  occurrences: number;
  kind: string;
  sessions: number;
  updated_at: string;
};

/** The inbox. */
export type LessonsReport = {
  root: string;
  lessons: LessonSummary[];
  /** How many lessons are waiting for a decision. */
  awaiting: number;
  /** How many lessons the store holds, the waiting ones and the history. */
  total: number;
};

/** What a decision did. */
export type LessonDecisionReport = {
  ok: boolean;
  id: string;
  state: string;
  reason: string;
  hint?: string;
};

/** What the caller knows about the decision. */
export type LessonDecisionOptions = {
  /** Who decided. The person running the command. */
  decidedBy?: string;
  /** Why. */
  reason?: string;
  /** The change the decision names. */
  changeRef?: string;
  /** The state an observation lands in. */
  outcome?: ObserveOutcome;
  /** The proof the decision rests on. */
  evalResult?: EvalResult;
  /** The file the proof is in. The content of an eval result file. */
  evalResultPath?: string;
};

/**
 * Who the decision is attributed to.
 *
 * The person running the command is the decider. The name comes from the
 * environment when it is set, because a person may want the record to say
 * who they are, and it is otherwise just "a person".
 */
export function deciderBy(override?: string): string {
  return override ?? process.env.OPENAGENTSY_USER ?? 'human';
}

/**
 * The inbox.
 */
export async function runLessons(root: string): Promise<LessonsReport> {
  const all = await listLessons(root);
  const pending = pendingLessons(all);
  return {
    root,
    lessons: pending.map((lesson) => ({
      id: lesson.id,
      state: lesson.state,
      summary: lesson.summary,
      occurrences: lesson.occurrences,
      kind: lesson.kind,
      sessions: lesson.sessions.length,
      updated_at: lesson.updated_at,
    })),
    awaiting: pending.length,
    total: all.length,
  };
}

/**
 * The inbox, as it is read.
 */
export function formatLessonsReport(report: LessonsReport): string {
  const lines: string[] = [];
  lines.push(`Lessons (${report.awaiting} awaiting a decision, ${report.total} in all)`);
  if (report.lessons.length === 0) {
    lines.push('  none');
    return `${lines.join('\n')}\n`;
  }
  for (const lesson of report.lessons) {
    const count = `${lesson.occurrences}x`.padStart(4);
    lines.push(`  ${lesson.id.padEnd(22)}${lesson.state.padEnd(14)}${count}  ${lesson.summary}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The proof a decision rests on, read from the result file.
 */
async function readEvalResult(path: string): Promise<EvalResult | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as EvalResult;
  } catch {
    return undefined;
  }
}

/**
 * Record a decision.
 */
export async function runLessonDecision(
  root: string,
  id: string,
  action: string,
  options: LessonDecisionOptions = {},
): Promise<LessonDecisionReport> {
  if (!(LESSON_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      id,
      state: '',
      reason: `unknown lesson action: ${action}`,
      hint: `an action is one of ${LESSON_ACTIONS.join(', ')}`,
    };
  }

  let evalResult = options.evalResult;
  if (evalResult === undefined && options.evalResultPath !== undefined) {
    evalResult = await readEvalResult(options.evalResultPath);
  }

  const outcome = await decideLesson(root, {
    id,
    action: action as LessonAction,
    decidedBy: deciderBy(options.decidedBy),
    reason: options.reason ?? `decided by the person running the command: ${action}`,
    ...(evalResult === undefined ? {} : { evalResult }),
    ...(options.changeRef === undefined ? {} : { changeRef: options.changeRef }),
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
  });

  if (!outcome.ok) {
    return { ok: false, id, state: '', reason: outcome.reason, hint: outcome.hint };
  }
  return {
    ok: true,
    id: outcome.lesson.id,
    state: outcome.lesson.state,
    reason: options.reason ?? `decided by the person running the command: ${action}`,
  };
}

/**
 * The decision, as it is read.
 */
export function formatLessonDecision(report: LessonDecisionReport): string {
  if (report.ok) {
    return `${report.id} is now ${report.state}\n`;
  }
  const hint = report.hint === undefined ? '' : `\nNext: ${report.hint}`;
  return `${report.reason}${hint}\n`;
}
