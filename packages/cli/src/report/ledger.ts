import { access } from 'node:fs/promises';
import type { CostFacts, ReportScope, ValueFacts, WasteFacts } from '@openagentsy/core';
import {
  closeLedger,
  type FetchLike,
  ledgerPath,
  ledgerTotals,
  offloadSavings,
  openLedger,
  outcomeTotals,
  type PriceLookup,
  perRoleTotals,
  priceMessage,
  tokensPerResult,
  wasteByKind,
  wasteTotals,
} from '@openagentsy/ledger';
import { footprintFacts } from './footprint.js';
import { type LedgerDb, shadowScope, windowDays } from './scope.js';

/**
 * The ledger, as the report reads it.
 *
 * Every number here is the ledger's own query, run over the rows the scope
 * selects. The report never totals a thing itself: it asks the ledger, and
 * the ledger answers.
 */

/** The facts the ledger gives the report. */
export type LedgerFacts = {
  cost: CostFacts;
  waste: WasteFacts;
  value: ValueFacts;
  /** The footprint of the scope, from the ledger's footprint table. */
  footprint: ReturnType<typeof footprintFacts>;
};

/**
 * A price, from the cache and never from the network.
 *
 * The report must not use the network, so the fetch always fails and the
 * cached snapshot is what is left. A price nobody cached is no price.
 */
const offlineFetch: FetchLike = async () => {
  throw new Error('the report does not use the network');
};

/**
 * The price of some tokens.
 *
 * The ledger asks the caller what the tokens would have cost on the cloud,
 * because only the caller knows which model the offloaded work replaced.
 * The report does not know it either, so the price comes from the cached
 * price of the model that ran the work, and a local run has no price at
 * all: the cloud price stays empty rather than pretending the work was
 * free.
 */
const offlinePrice: PriceLookup = async (provider, model, tokens) => {
  const result = await priceMessage(provider, model, tokens, { fetchImpl: offlineFetch });
  return result.cost;
};

/** A number, when it is one. */
function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A number that may be absent. */
function optional(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The cost of the scope.
 *
 * The tokens and the roles are the ledger's totals, and the split between
 * the spend the host reported and the spend the pricing chain estimated is
 * read from the same table the totals come from.
 */
function costOf(db: LedgerDb): CostFacts {
  const totals = ledgerTotals(db);
  const roles = perRoleTotals(db);
  const split = db
    .query(
      `SELECT
        SUM(cost_reported) AS reported,
        SUM(cost_estimated) AS estimated,
        COUNT(DISTINCT CASE
          WHEN cost_reported IS NULL AND cost_estimated IS NULL
          THEN provider || '|' || model END) AS unpriced_models,
        SUM(CASE
          WHEN cost_reported IS NULL AND cost_estimated IS NULL THEN 1 ELSE 0 END) AS unpriced_messages
       FROM usage`,
    )
    .get() as Record<string, unknown> | null;

  return {
    present: totals.messages > 0,
    messages: totals.messages,
    tokens: totals.tokens,
    roles: roles.map((row) => ({
      role: row.role,
      tokens: row.tokens,
      usd: row.usd,
      unpriced: row.unpriced,
    })),
    reportedUsd: optional(split?.reported),
    estimatedUsd: optional(split?.estimated),
    unpricedModels: n(split?.unpriced_models),
    unpricedMessages: n(split?.unpriced_messages),
  };
}

/** The waste of the scope. */
function wasteOf(db: LedgerDb): WasteFacts {
  const totals = wasteTotals(db);
  const byKind = wasteByKind(db);
  return {
    present: byKind.length > 0,
    tokens: totals.tokens,
    percentage: totals.percentage,
    byKind: byKind.map((row) => ({
      kind: row.kind,
      count: row.count,
      tokens: row.tokens,
      percentage: row.percentage,
    })),
  };
}

/** The value of the scope. */
async function worthOf(db: LedgerDb, scope: ReportScope): Promise<ValueFacts> {
  const outcomes = outcomeTotals(db);
  const results = tokensPerResult(db, windowDays(scope));
  const offload = await offloadSavings(db, offlinePrice);
  return {
    present:
      outcomes.tasksCompleted + outcomes.tasksScrapped + outcomes.commits + outcomes.prsMerged > 0,
    tasksCompleted: outcomes.tasksCompleted,
    tasksScrapped: outcomes.tasksScrapped,
    commits: outcomes.commits,
    prsMerged: outcomes.prsMerged,
    tokensPerTask: results.tokensPerTask,
    tokensPerCommit: results.tokensPerCommit,
    offloadMessages: offload.messages,
    offloadTokens: offload.tokens,
    offloadUsd: offload.usd,
    offloadCloudUsd: offload.cloudUsd,
    offloadSavedUsd: offload.savedUsd,
  };
}

/** The facts of a project with no ledger. */
function emptyFacts(): LedgerFacts {
  return {
    cost: {
      present: false,
      messages: 0,
      tokens: 0,
      roles: [],
      reportedUsd: null,
      estimatedUsd: null,
      unpricedModels: 0,
      unpricedMessages: 0,
    },
    waste: { present: false, tokens: 0, percentage: 0, byKind: [] },
    value: {
      present: false,
      tasksCompleted: 0,
      tasksScrapped: 0,
      commits: 0,
      prsMerged: 0,
      tokensPerTask: null,
      tokensPerCommit: null,
      offloadMessages: 0,
      offloadTokens: 0,
      offloadUsd: null,
      offloadCloudUsd: null,
      offloadSavedUsd: null,
    },
    footprint: footprintFacts(null),
  };
}

/**
 * The facts of the scope, from the ledger.
 *
 * A project with no ledger has nothing to show, and reading it must not
 * create one: the file is only opened when it is there.
 */
export async function ledgerFacts(stateRoot: string, scope: ReportScope): Promise<LedgerFacts> {
  const path = ledgerPath(stateRoot);
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (!exists) return emptyFacts();

  const db = openLedger(stateRoot);
  try {
    shadowScope(db, scope);
    return {
      cost: costOf(db),
      waste: wasteOf(db),
      value: await worthOf(db, scope),
      footprint: footprintFacts(db),
    };
  } finally {
    closeLedger(db);
  }
}
