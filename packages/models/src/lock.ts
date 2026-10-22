import { readFile, writeFile } from 'node:fs/promises';
import type { RoleDefinition, RolesFile } from '@openagentsy/core';
import { type Rejection, type Selection, type SelectOptions, selectModel } from './score.js';
import type { Candidate, ModelLock, ModelLockEntry, ProviderModel } from './types.js';

export const LOCK_FILE_NAME = 'openagentsy.models.lock.json';

export async function readLock(path: string): Promise<ModelLock | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as ModelLock;
  } catch {
    return undefined;
  }
}

export async function writeLock(path: string, lock: ModelLock): Promise<void> {
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

/**
 * The effort levels a role may use, taken from the model it was given.
 *
 * A role names the level it wants, but the model decides which levels exist.
 * glm-5.3 offers low, high and max, so a role that asks for medium gets the
 * lowest level the model has, and a role that asks for xhigh gets the
 * highest. A model with no effort levels gets a single rung.
 */
export function ladderVariants(
  role: RoleDefinition,
  model: ProviderModel | undefined,
): { start?: string; ceiling?: string } {
  const available = model?.variants ?? [];
  if (available.length === 0) return {};

  const start = available.includes(role.effort.startVariant)
    ? role.effort.startVariant
    : (available[0] ?? role.effort.startVariant);
  const ceiling = available.includes(role.effort.ceilingVariant)
    ? role.effort.ceilingVariant
    : (available[available.length - 1] ?? role.effort.ceilingVariant);

  return { start, ceiling };
}

export type BuildLockInput = {
  roles: RolesFile;
  candidates: Candidate[];
  providers: ModelLock['providers'];
  allowTraining?: boolean;
  allowRetention?: boolean;
  date?: string;
};

export type BuildLockResult = {
  lock: ModelLock;
  reasons: Record<string, string>;
  rejected: Record<string, Rejection[]>;
  failures: Record<string, string>;
};

/**
 * Choose a model for every role and write the effort ladder for it.
 *
 * The reviewer is selected after the builder so it can be kept off the
 * builder's creator, which is the cross family rule from the plan.
 */
/** Record what the selector chose for one role. */
function record(
  entries: Record<string, ModelLockEntry>,
  reasons: Record<string, string>,
  rejected: Record<string, Rejection[]>,
  role: { name: string },
  selection: Selection,
): void {
  entries[role.name] = {
    model: selection.model.openCodeId,
    ...(selection.runnerUp ? { runnerUp: selection.runnerUp.openCodeId } : {}),
    evidence: selection.evidence,
    ladder: [],
  };
  reasons[role.name] = selection.reason;
  rejected[role.name] = selection.rejected;
}
export function buildLock(input: BuildLockInput): BuildLockResult {
  const { roles, candidates } = input;
  const entries: Record<string, ModelLockEntry> = {};
  const reasons: Record<string, string> = {};
  const rejected: Record<string, Rejection[]> = {};
  const failures: Record<string, string> = {};

  const select = (role: RoleDefinition, extra: Partial<SelectOptions> = {}) =>
    selectModel({
      profile: role.modelProfile,
      candidates,
      allowTraining: input.allowTraining ?? false,
      allowRetention: input.allowRetention ?? false,
      date: input.date,
      ...extra,
    });

  const order = Object.values(roles.roles).filter(
    (role) => role.modelProfile.differentCreatorThan !== undefined,
  );
  const rest = Object.values(roles.roles).filter(
    (role) => role.modelProfile.differentCreatorThan === undefined,
  );

  const selectSimple = (role: RoleDefinition): void => {
    let selection: ReturnType<typeof selectModel>;
    try {
      selection = select(role);
    } catch (error) {
      failures[role.name] = error instanceof Error ? error.message : String(error);
      return;
    }
    record(entries, reasons, rejected, role, selection);
  };

  for (const role of rest) selectSimple(role);

  for (const role of order) {
    const other = role.modelProfile.differentCreatorThan
      ? roles.roles[role.modelProfile.differentCreatorThan]
      : undefined;
    const otherModel = other ? entries[other.name]?.model : undefined;
    const creator = candidates.find((candidate) => candidate.model.openCodeId === otherModel)?.model
      .creator;
    let selection: ReturnType<typeof selectModel>;
    try {
      selection = select(role, creator ? { excludeCreators: [creator] } : {});
    } catch (error) {
      failures[role.name] = error instanceof Error ? error.message : String(error);
      continue;
    }
    record(entries, reasons, rejected, role, selection);
  }

  for (const role of Object.values(roles.roles)) {
    const entry = entries[role.name];
    if (!entry) continue;
    const ceilingRole = role.effort.ceilingModelRole;
    const ceilingModelId = ceilingRole ? entries[ceilingRole]?.model : entry.model;
    if (!ceilingModelId) continue;

    const own = candidates.find((candidate) => candidate.model.openCodeId === entry.model)?.model;
    const ceilingModel = candidates.find(
      (candidate) => candidate.model.openCodeId === ceilingModelId,
    )?.model;

    const start = ladderVariants(role, own);
    const ceiling = ladderVariants(role, ceilingModel);

    const ladder: { model: string; variant?: string }[] = [
      { model: entry.model, ...(start.start !== undefined ? { variant: start.start } : {}) },
    ];
    const top = {
      model: ceilingModelId,
      ...(ceiling.ceiling !== undefined ? { variant: ceiling.ceiling } : {}),
    };
    const same =
      ladder[0]?.model === top.model && (ladder[0]?.variant ?? '') === (top.variant ?? '');
    if (!same) ladder.push(top);
    entry.ladder = ladder;
  }

  return {
    lock: {
      generatedAt: new Date().toISOString(),
      providers: input.providers,
      roles: entries,
    },
    reasons,
    rejected,
    failures,
  };
}
