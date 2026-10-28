import type { SessionMessageInfo } from '@opencode/client';
import { buildFootprintConfig, type FootprintConfig } from '../config.js';
import type {
  AccountabilityView,
  BoardView,
  BudgetView,
  MemoryView,
  TasksView,
} from '../readers.js';

/**
 * The fixtures the block tests render.
 *
 * A block renders a view, and the view holds the copy the block shows. The
 * fixtures live here, so the block tests and the framing rules - which look
 * at every block - read the same copy.
 */

/** One assistant message, as the host hands it over. */
export const MESSAGES: SessionMessageInfo[] = [
  {
    id: 'msg_fixture_1',
    type: 'assistant',
    agent: 'build',
    model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' },
    content: [],
    time: { created: 1_000, completed: 21_000 },
    tokens: { input: 1_200, output: 4_000, reasoning: 0, cache: { read: 800, write: 0 } },
    cost: 0.12,
  },
];

/** The configuration of a project that has the EcoLogits data. */
export const CONFIG: FootprintConfig = buildFootprintConfig({
  region: 'WORLD',
  grid: { WORLD: { kgCo2PerKWh: [0.4, 0.6], wueLPerKWh: [1, 2] } },
  models: {
    'anthropic/claude-sonnet-4-5': { totalParamsB: [200, 200], activeParamsB: [30, 30] },
  },
  throughput: {
    'anthropic/claude-sonnet-4-5': { ttftS: [0.5, 1.5], tps: [40, 80] },
  },
});

/** The configuration of a project that has configured nothing. */
export const EMPTY_CONFIG: FootprintConfig = buildFootprintConfig({});

/** The board, with a lease and a budget on it. */
export const BOARD: BoardView = {
  records: 12,
  leases: [{ bean: 'proj-42', agent: 'builder-2', glob: 'packages/core/**', minutes: 7 }],
  budgets: [{ bean: 'proj-42', tokenLimit: 180_000, stopAt: 153_000, tokensUsed: 40_000 }],
};

/** The board, with nothing on it. */
export const EMPTY_BOARD: BoardView = { records: 0, leases: [], budgets: [] };

/** The tasks, with work open and work waiting to be picked up. */
export const TASKS: TasksView = {
  inProgress: [{ id: 'oa-4f2k', title: 'fix the ranges' }],
  ready: [
    { id: 'oa-9x1p', title: 'write the reader' },
    { id: 'oa-2b7q', title: 'add the check' },
  ],
  blocked: 2,
};

/** The tasks, with no work open. */
export const EMPTY_TASKS: TasksView = { inProgress: [], ready: [], blocked: 0 };

/** The budget, with a run behind it. */
export const BUDGET: BudgetView = {
  totals: {
    messages: 12,
    tokens: 12_345,
    input: 4_000,
    output: 8_000,
    reasoning: 0,
    cacheRead: 200,
    cacheWrite: 145,
    usd: 0.42,
    unpricedMessages: 0,
  },
  byRole: [
    { role: 'build', messages: 8, tokens: 8_000, usd: 0.3, unpriced: 0 },
    { role: 'lead', messages: 4, tokens: 4_345, usd: 0.12, unpriced: 0 },
  ],
  waste: { tokens: 120, percentage: 1 },
  tokensPerTask: 4_000,
  offload: { messages: 3, tokens: 2_000, usd: 0.01 },
  caps: [
    { bean: 'proj-42', tokenLimit: 180_000, stopAt: 153_000, tokensUsed: 40_000, stop: false },
  ],
};

/** The budget, with no run behind it. */
export const EMPTY_BUDGET: BudgetView = {
  totals: {
    messages: 0,
    tokens: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    usd: null,
    unpricedMessages: 0,
  },
  byRole: [],
  waste: { tokens: 0, percentage: 0 },
  tokensPerTask: null,
  offload: { messages: 0, tokens: 0, usd: null },
  caps: [],
};

/** The memory inbox, with candidates waiting for a decision. */
export const MEMORY: MemoryView = {
  candidates: [
    {
      id: 12,
      text: 'the board reader lives in the core package',
      category: 'build',
      source: '12 · core',
    },
    { id: 13, text: 'the ledger is the measurement', category: 'run', source: '13 · ledger' },
  ],
};

/** The memory inbox, with no candidate waiting. */
export const EMPTY_MEMORY: MemoryView = { candidates: [] };

/** The accountability, with decisions waiting. */
export const ACCOUNTABILITY: AccountabilityView = {
  lessons: 3,
  waivers: 2,
  memory: 1,
  outcomes: { tasksCompleted: 2, tasksScrapped: 0, commits: 5, prsMerged: 1 },
};

/** The accountability, with nothing waiting. */
export const EMPTY_ACCOUNTABILITY: AccountabilityView = {
  lessons: 0,
  waivers: 0,
  memory: 0,
  outcomes: { tasksCompleted: 0, tasksScrapped: 0, commits: 0, prsMerged: 0 },
};
