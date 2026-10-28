import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  checkBudget,
  closeDatabase,
  listBudgets,
  listLeases,
  listRecords,
  openDatabase,
} from '@openagentsy/core';
import { accountabilityCounts, listLessons, pendingLessons } from '@openagentsy/hooks';
import {
  closeLedger,
  emptyLedgerExport,
  type LedgerExport,
  ledgerExport,
  ledgerPath,
  openLedger,
  perTaskTotals,
} from '@openagentsy/ledger';
import { isPending, parseCandidate } from '@openagentsy/memory';
import { index, openStore, ready, sortTasks, TERMINAL } from '@openagentsy/tasks';

/**
 * The readers of the sidebar.
 *
 * Every number a block shows is read here, and every one of them comes from
 * the package that owns it: the board's counts from the core, the ledger's
 * totals from the ledger, the tasks from the task store, the candidates from
 * the memory package and the lessons and the waivers from the hooks. A block
 * that re-computed a number would be a second answer to a question the
 * project already answers, and the two would drift.
 *
 * The readers answer with a view model and nothing else: a block renders a
 * view and never reaches for a file, which is what makes a block testable
 * from a fixture.
 */

/** What the board block shows. */
export interface BoardView {
  /** How many records the board holds. */
  readonly records: number;
  /** The leases that are held, and how long they have been held. */
  readonly leases: readonly {
    readonly bean: string;
    readonly agent: string;
    readonly glob: string;
    readonly minutes: number;
  }[];
  /** The cap of every bean that has one, and what the bean has spent. */
  readonly budgets: readonly {
    readonly bean: string;
    readonly tokenLimit: number;
    readonly stopAt: number;
    readonly tokensUsed: number;
  }[];
}

/** What the tasks block shows. */
export interface TasksView {
  /** The tasks that are being worked on. */
  readonly inProgress: readonly { readonly id: string; readonly title: string }[];
  /** The tasks that can be picked up now. */
  readonly ready: readonly { readonly id: string; readonly title: string }[];
  /** How many tasks are blocked. */
  readonly blocked: number;
}

/** What the budget block shows. */
export interface BudgetView {
  /** The tokens of every message, and what they cost. */
  readonly totals: LedgerExport['totals'];
  /** The tokens of each resolved role. */
  readonly byRole: LedgerExport['byRole'];
  /** The waste tokens, and the share of the total they are. */
  readonly waste: LedgerExport['waste'];
  /** The tokens one completed task cost. */
  readonly tokensPerTask: number | null;
  /** The work that ran on the machine in front of the person. */
  readonly offload: LedgerExport['offload'];
  /** The cap of every bean that has one, and what it has spent. */
  readonly caps: readonly {
    readonly bean: string;
    readonly tokenLimit: number;
    readonly stopAt: number;
    readonly tokensUsed: number;
    readonly stop: boolean;
  }[];
}

/** What the memory inbox block shows. */
export interface MemoryView {
  /** The candidates no person has decided on. */
  readonly candidates: readonly {
    readonly id: number;
    readonly text: string;
    readonly category: string;
    readonly source: string;
  }[];
}

/** What the accountability block shows. */
export interface AccountabilityView {
  /** The lessons that are waiting for a person. */
  readonly lessons: number;
  /** The waivers a person recorded. */
  readonly waivers: number;
  /** The memory candidates that are waiting for a decision. */
  readonly memory: number;
  /** The outcomes the ledger recorded. */
  readonly outcomes: LedgerExport['outcomes'];
}

/** The path of the board's database. */
function boardPath(stateRoot: string): string {
  return join(stateRoot, '.openagentsy', 'board.sqlite');
}

/** Whether a file is there. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The minutes between a moment and now. */
function minutesSince(moment: string): number {
  const then = Date.parse(moment);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.round((Date.now() - then) / 60_000));
}

/**
 * The board, as the block shows it.
 *
 * A project that has no board yet has nothing to show, and reading it must
 * not create one: the file is checked before the database is opened, the
 * way the command that shows the board checks it.
 */
export async function readBoard(stateRoot: string): Promise<BoardView> {
  const path = boardPath(stateRoot);
  if (!(await exists(path))) return { records: 0, leases: [], budgets: [] };

  const db = openDatabase(path);
  try {
    // The count is the number of records past the cursor, and the cursor is
    // zero, so it is the size of the whole board.
    const inbox = listRecords(db, { limit: 1 });
    return {
      records: inbox.unread,
      leases: listLeases(db).map((lease) => ({
        bean: lease.bean,
        agent: lease.agent,
        glob: lease.glob,
        minutes: minutesSince(lease.grantedAt),
      })),
      budgets: listBudgets(db).map((budget) => ({
        bean: budget.bean,
        tokenLimit: budget.tokenLimit,
        stopAt: budget.stopAt,
        tokensUsed: budget.tokensUsed,
      })),
    };
  } finally {
    closeDatabase(db);
  }
}

/**
 * The tasks, as the block shows them.
 *
 * The store is the project's own: the tasks are the files of `.beans/`, and
 * the store finds them the way the rest of the project finds them.
 */
export async function readTasks(workspace: string): Promise<TasksView> {
  const store = await openStore(workspace);
  const tasks = await store.all();
  const ix = index(tasks);
  const brief = (task: { id: string; title: string }) => ({ id: task.id, title: task.title });

  return {
    inProgress: tasks
      .filter((task) => task.status === 'in-progress')
      .sort(sortTasks)
      .map(brief),
    ready: ready(tasks).slice(0, 3).map(brief),
    blocked: tasks.filter((task) => !TERMINAL.has(task.status) && ix.isBlocked(task)).length,
  };
}

/**
 * The budget, as the block shows it.
 *
 * The caps are the board's and the usage is the ledger's: the check itself
 * is the board's own, so the number the block shows and the number the
 * budget tool shows are the same number.
 */
export async function readBudget(stateRoot: string): Promise<BudgetView> {
  const ledger = ledgerPath(stateRoot);
  const board = boardPath(stateRoot);
  const hasLedger = await exists(ledger);
  const hasBoard = await exists(board);

  if (!hasLedger) {
    const empty = emptyLedgerExport();
    return {
      totals: empty.totals,
      byRole: empty.byRole,
      waste: empty.waste,
      tokensPerTask: empty.tokensPerCompletedTask,
      offload: empty.offload,
      caps: [],
    };
  }

  const db = openLedger(stateRoot);
  try {
    const counters = ledgerExport(db);
    const caps: {
      bean: string;
      tokenLimit: number;
      stopAt: number;
      tokensUsed: number;
      stop: boolean;
    }[] = [];
    if (hasBoard) {
      const boardDb = openDatabase(board);
      try {
        // The ledger counts the tokens per task, and the board's bean id is
        // that task id, so the measurement of a bean is the ledger's own
        // per-task total.
        const perBean = new Map(perTaskTotals(db).map((row) => [row.taskId, row.tokens]));
        for (const budget of listBudgets(boardDb)) {
          const decision = checkBudget(boardDb, budget.bean, budget.tokensUsed, {
            total: (bean) => perBean.get(bean),
          });
          caps.push({
            bean: decision.bean,
            tokenLimit: decision.tokenLimit,
            stopAt: decision.stopAt,
            tokensUsed: decision.tokensUsed,
            stop: decision.stop,
          });
        }
      } finally {
        closeDatabase(boardDb);
      }
    }
    return {
      totals: counters.totals,
      byRole: counters.byRole,
      waste: counters.waste,
      tokensPerTask: counters.tokensPerCompletedTask,
      offload: counters.offload,
      caps,
    };
  } finally {
    closeLedger(db);
  }
}

/**
 * The memory candidates, as the block shows them.
 *
 * The candidates are the board's pending `bean: memory` records, and the
 * memory package owns what a pending record is and what a candidate carries.
 */
export async function readMemory(stateRoot: string): Promise<MemoryView> {
  const path = boardPath(stateRoot);
  if (!(await exists(path))) return { candidates: [] };

  const db = openDatabase(path);
  try {
    const inbox = listRecords(db, { limit: 200 });
    const candidates = inbox.records
      .filter((record) => isPending(record))
      .map((record) => {
        const candidate = parseCandidate(record);
        return {
          id: record.id,
          text: candidate.text,
          category: candidate.category,
          source: candidate.source,
        };
      });
    return { candidates };
  } finally {
    closeDatabase(db);
  }
}

/**
 * The accountability, as the block shows it.
 *
 * The lessons and the waivers come from the hooks, the candidates from the
 * memory package and the outcomes from the ledger. The three counts the plan
 * names and the project does not keep - the redaction counter, the audit log
 * and the conformance count - are not in this view, because nothing counts
 * them.
 */
export async function readAccountability(stateRoot: string): Promise<AccountabilityView> {
  const lessons = await listLessons(stateRoot);
  const counts = await accountabilityCounts(stateRoot);
  const memory = await readMemory(stateRoot);

  const ledger = ledgerPath(stateRoot);
  let outcomes = emptyLedgerExport().outcomes;
  if (await exists(ledger)) {
    const db = openLedger(stateRoot);
    try {
      outcomes = ledgerExport(db).outcomes;
    } finally {
      closeLedger(db);
    }
  }

  return {
    lessons: pendingLessons(lessons).length,
    waivers: counts.waivers,
    memory: memory.candidates.length,
    outcomes,
  };
}
