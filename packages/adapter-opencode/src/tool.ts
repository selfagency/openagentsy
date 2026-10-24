import { z } from 'zod';

/**
 * The OpenCode plugin SDK's tool helper, without the SDK.
 *
 * The published `@opencode-ai/plugin` package is a type package plus a
 * two line runtime: `tool` returns its input and `tool.schema` is zod. A
 * plugin file is loaded from the config directory, where bare imports do not
 * resolve, so the adapter has to be self contained. This is that same two
 * lines, with the types taken from the SDK at build time.
 */
export type ToolArgs = Record<string, z.ZodType>;

export type ToolDefinition<Args extends ToolArgs = ToolArgs> = {
  description: string;
  args: Args;
  execute: (
    args: z.infer<z.ZodObject<Args>>,
    context: {
      sessionID: string;
      messageID: string;
      agent: string;
      directory: string;
      worktree: string;
      abort: AbortSignal;
      metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void;
    },
  ) => Promise<string>;
};

export const tool = Object.assign(
  <Args extends ToolArgs>(input: ToolDefinition<Args>): ToolDefinition<Args> => input,
  { schema: z },
);
