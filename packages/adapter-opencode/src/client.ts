/**
 * The OpenCode client, as far as this plugin uses it.
 *
 * The V1 SDK is a client, not a contract, so the shape is written down here
 * once and both the V1 path and the harvest use it. A change in the SDK
 * shows up in one place.
 */

import type { HarvestSession } from './harvest.js';

export type ProviderModelInfo = {
  variants?: Record<string, Record<string, unknown>>;
};

/** The session part of the client. */
export type SessionClient = {
  create: (options: {
    body: { title: string; parentID?: string };
    query?: { directory?: string };
  }) => Promise<{ data?: { id?: string } }>;
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
        body: { title, parentID },
        query: { directory },
      });
      return created.data?.id;
    },
    prompt: async ({ sessionID, agent, text }) => {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { agent, parts: [{ type: 'text', text }] },
        query: { directory },
      });
    },
  };
}
