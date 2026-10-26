/**
 * The OpenCode client, as far as this plugin uses it.
 *
 * The V1 SDK is a client, not a contract, so the shape is written down here
 * once and both the V1 path and the harvest use it. A change in the SDK
 * shows up in one place.
 */

import type { HarvestSession } from './harvest.js';
import { type PruneSessionRow, pruneHarvestChildren } from './harvest.js';

export type ProviderModelInfo = {
  variants?: Record<string, Record<string, unknown>>;
};

/** The session part of the client. */
export type SessionClient = {
  create: (options: {
    body: { title: string; parentID?: string };
    query?: { directory?: string };
  }) => Promise<{ data?: { id?: string } }>;
  /**
   * Look a session up.
   *
   * The SDK answers with `data` when the row exists and with the typed
   * `NotFoundError` when it does not. It returns the error rather than
   * throwing unless the client was built with `throwOnError`.
   *
   * The row carries the parent, which is how the bridge finds the session a
   * subagent's usage rolls up to.
   */
  get: (options: {
    path: { id: string };
    query?: { directory?: string };
  }) => Promise<{ data?: { id?: string; parentID?: string }; error?: { name?: string } }>;
  /**
   * List the sessions of a directory.
   *
   * The V1 SDK type omits `agent`, but the server row carries it (the V2
   * type keeps it), so the row is typed with it optional: a runtime that
   * does not send it leaves the janitor with nothing to identify.
   */
  list: (options: { query?: { directory?: string } }) => Promise<{ data?: PruneSessionRow[] }>;
  /**
   * Delete a session and all its data.
   *
   * A row that is already gone answers with the typed `NotFoundError`, or
   * with the wrapped form under `throwOnError`. That is the same end state
   * as a delete that succeeded, so the adapter treats it as a no-op.
   */
  delete: (options: {
    path: { id: string };
    query?: { directory?: string };
  }) => Promise<{ data?: boolean; error?: { name?: string } }>;
  messages: (options: {
    path: { id: string };
    query?: { directory?: string };
  }) => Promise<{ data?: { parts?: { type: string; text?: string }[] }[] }>;
  promptAsync: (options: {
    path: { id: string };
    body: {
      noReply?: boolean;
      agent?: string;
      model?: { providerID: string; modelID: string };
      parts: { type: 'text'; text: string; synthetic?: boolean; ignored?: boolean }[];
    };
    query?: { directory?: string };
  }) => Promise<unknown>;
};

/** The provider inventory the client returns. */
export type ProviderInventory = {
  data?: { all?: { id: string; models: Record<string, ProviderModelInfo> }[] };
};

export type ClientLike = {
  provider: {
    list: () => Promise<ProviderInventory>;
  };
  session: SessionClient;
};

/**
 * The V1 client, as the three things a harvest needs.
 *
 * The V2 path speaks to the plugin context instead, so the harvest asks for
 * what it needs rather than for a client.
 */
export function sessionAdapter(
  client: { session: SessionClient },
  directory: string,
): HarvestSession {
  return {
    messages: async (sessionID) => {
      const messages = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      });
      return messages.data ?? [];
    },
    create: async ({ title, parentID }) => {
      const created = await client.session.create({
        body: { title, ...(parentID !== undefined ? { parentID } : {}) },
        query: { directory },
      });
      return created.data?.id;
    },
    exists: async (sessionID) => {
      let found: { data?: { id?: string }; error?: { name?: string } };
      try {
        found = await client.session.get({
          path: { id: sessionID },
          query: { directory },
        });
      } catch (error) {
        // A client built with throwOnError reports the typed error as a throw.
        if (isNotFound(error)) return false;
        throw error;
      }
      if (found.error !== undefined) {
        if (isNotFound(found.error)) return false;
        // Any other error is the server not answering the question. It must
        // not be read as "present": the session is left unprompted.
        throw new Error(
          `the session lookup for ${sessionID} failed: ${found.error.name ?? 'unknown error'}`,
        );
      }
      if (found.data === undefined) {
        throw new Error(`the session lookup for ${sessionID} answered with no session`);
      }
      return true;
    },
    prompt: async ({ sessionID, agent, text }) => {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { agent, parts: [{ type: 'text', text }] },
        query: { directory },
      });
    },
    prune: async () => {
      await pruneHarvestChildren(
        {
          list: async () => {
            const listed = await client.session.list({ query: { directory } });
            return listed.data ?? [];
          },
          delete: async (sessionID) => {
            let removed: { data?: boolean; error?: { name?: string } };
            try {
              removed = await client.session.delete({
                path: { id: sessionID },
                query: { directory },
              });
            } catch (error) {
              // Deleting a row that is already gone asks for the same end
              // state, so it is not a failure.
              if (isNotFound(error)) return;
              throw error;
            }
            if (removed.error !== undefined && !isNotFound(removed.error)) {
              throw new Error(
                `the session delete for ${sessionID} failed: ${removed.error.name ?? 'unknown error'}`,
              );
            }
          },
        },
        directory,
      );
    },
  };
}

/**
 * Whether an error is the SDK's typed "not found".
 *
 * Two shapes are accepted:
 *
 * - the typed error itself, `{ name: 'NotFoundError' }`, which the SDK
 *   returns on the response and throws when `throwOnError` is set;
 * - the plain `Error` the SDK's error interceptor builds under
 *   `throwOnError`: its own `name` is `Error`, and the parsed body sits at
 *   `cause.body`, so `{ cause: { body: { name: 'NotFoundError' } } }` is
 *   the same answer as the typed error.
 */
function isNotFound(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if ((value as { name?: unknown }).name === 'NotFoundError') return true;
  const cause = (value as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const body = (cause as { body?: unknown }).body;
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { name?: unknown }).name === 'NotFoundError'
  );
}
