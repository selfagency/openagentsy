import {
  decideLesson,
  type EvalResult,
  LESSON_ACTIONS,
  type LessonAction,
  type LessonState,
  listLessons,
  type ObserveOutcome,
  pendingLessons,
  readEvalResult,
} from '@openagentsy/hooks';
import { deciderBy } from '../who.js';

export { deciderBy };

/**
 * The lesson commands.
 *
 * `/oa lessons` is the inbox: the lessons that are waiting for a person,
 * with the ones that happened most often first. `/oa lesson <id>
 * validate|apply|reject|observe` records the decision, and the decision is
 * the person's: the command runs as the person, so `decidedBy` is the human.
 *
 * The lessons are the state root's: they are what the project learned, and
 * a worktree of the project has the same lessons as the project.
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
 * The inbox.
 */
export async function runLessons(stateRoot: string): Promise<LessonsReport> {
  const all = await listLessons(stateRoot);
  const pending = pendingLessons(all);
  return {
    root: stateRoot,
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
 * Record a decision.
 */
export async function runLessonDecision(
  stateRoot: string,
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
    const read = await readEvalResult(stateRoot, options.evalResultPath);
    if (read.error !== undefined) {
      return {
        ok: false,
        id,
        state: '',
        reason: `the proof result could not be read: ${read.error}`,
        hint: 'the result file has to be there, and it has to be the JSON the runner wrote',
      };
    }
    evalResult = read.result;
  }

  const outcome = await decideLesson(stateRoot, {
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
