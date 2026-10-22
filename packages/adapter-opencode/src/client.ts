/**
 * The OpenCode client, as far as this plugin uses it.
 *
 * The V1 SDK is a client, not a contract, so the shape is written down here
 * once and both the V1 path and the harvest use it. A change in the SDK
 * shows up in one place.
 */

export type ProviderModelInfo = {
  variants?: Record<string, Record<string, unknown>>;
};

/** The session part of the client. */
export type SessionClient = {
  create: (options: {
    body: { title: string };
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

export type ClientLike = {
  provider: {
    list: () => Promise<{
      data?: { all?: { id: string; models: Record<string, ProviderModelInfo> }[] };
    }>;
  };
  session: SessionClient;
};
