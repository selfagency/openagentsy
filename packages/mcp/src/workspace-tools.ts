import { type BoardDatabase, listRecords, setRecordState } from '@openagentsy/core';
import { createFindingsStore, qualityTools } from '@openagentsy/hooks';
import {
  createMemoryTools,
  MemoryInbox,
  type BoardRecord as MemoryRecord,
  MemoryStore,
} from '@openagentsy/memory';
import { openStore, taskTools } from '@openagentsy/tasks';
import { type PackageTool, type ServerTool, serverTool } from './mcp-tool.js';

/**
 * The tools the workspace packages offer, over the stores they need.
 *
 * The board is the server a session talks to, and the packages that hold
 * the state offer tools of their own. The server registers them here: the
 * names, the descriptions and the schemas come from the packages, and this
 * module only opens the stores they read and write.
 *
 * The task store is the project's own: the tasks are files in `.beans/`,
 * committed with the code, and the store finds them the way the rest of
 * the project finds them - through `.beans.yml`. The memory store is the
 * state's: `.openagentsy/memory.jsonl` under the state root, beside the
 * board's own database.
 */

/** How many records one page of the board holds. */
const PAGE_SIZE = 100;

/** What the wiring needs. */
export type WorkspaceToolsOptions = {
  /** The state root: where the board and the memory store live. */
  root: string;
  /** The board the memory inbox reads its candidates from. */
  db: BoardDatabase;
};

/**
 * The task tools and the memory tools, ready to register.
 *
 * The tools are opened once, when the server starts, and the stores they
 * hold are the ones the state root names: a server that ran from another
 * root would read another project's tasks and another project's memories.
 */
export async function workspaceTools(options: WorkspaceToolsOptions): Promise<ServerTool[]> {
  const findings = createFindingsStore(options.root);
  const store = await openStore(options.root, {
    // A task with an open floor finding cannot be completed, and the
    // findings are the ones the check recorded in the state root.
    openFloorFindings: async (taskId) => await findings.openFloor(taskId),
  });
  const memory = new MemoryStore({ root: options.root });
  const inbox = new MemoryInbox({
    root: options.root,
    store: memory,
    read: async () => everyRecord(options.db),
    markState: async (recordId, state) => {
      setRecordState(options.db, recordId, state);
    },
  });

  const tools: Record<string, PackageTool> = {
    ...taskTools(store),
    ...createMemoryTools({ store: memory, inbox }),
    ...qualityTools({ workspace: options.root }),
  };
  return Object.entries(tools).map(([name, def]) => serverTool(name, def));
}

/**
 * Every record on the board, in order.
 *
 * The inbox reads the board's records, and the board holds more than one
 * page of them: a page is a hundred records, not the whole board, so the
 * pages are walked until one comes back short.
 */
async function everyRecord(db: BoardDatabase): Promise<MemoryRecord[]> {
  const found: MemoryRecord[] = [];
  let cursor = 0;
  for (;;) {
    const page = listRecords(db, { cursor, limit: PAGE_SIZE });
    found.push(...page.records);
    if (page.records.length < PAGE_SIZE) return found;
    cursor = page.nextCursor;
  }
}
