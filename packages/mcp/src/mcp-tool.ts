import { z } from 'zod';

/**
 * The shape the MCP server speaks in.
 *
 * A tool answers with text, and a refusal answers with the reason and the
 * next step. The board's tools, the lesson tools and the workspace tools
 * all answer that way, so the shape is written once here.
 */

/** What an MCP tool answers with. */
export type McpToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** The answer, as JSON. */
export function text(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * The failure, as JSON, with the next step.
 *
 * The caller is an agent: it can act on a sentence and it cannot act on a
 * stack trace, so the message says what failed and what to do next.
 */
export function failure(reason: string, hint?: string): McpToolResult {
  const body = hint === undefined ? reason : `${reason}\n\nNext: ${hint}`;
  return { content: [{ type: 'text', text: body }], isError: true };
}

/**
 * A tool as the packages write it.
 *
 * The task and the memory packages write their tools with the adapter's
 * helper, which takes a zod schema and a callback. The board server does
 * not depend on the adapter - that is the plugin's package, and a server
 * that imports it loads the plugin - so the shape the server needs is
 * written here, and the packages' tools fit it.
 */
export type PackageTool = {
  description: string;
  args: z.ZodType;
  execute(args: unknown, context: { sessionID: string; agent: string }): Promise<unknown>;
};

/** One tool, in the shape the MCP server registers it in. */
export type ServerTool = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (input: unknown) => Promise<McpToolResult>;
};

/**
 * The context a tool is called with.
 *
 * The board server serves every session of the project, so it knows no
 * session and no agent. The tools it registers do not read the context,
 * and the placeholders say so rather than naming a session that is not
 * there.
 */
const SERVER_CONTEXT = { sessionID: 'mcp-board', agent: 'board' };

/**
 * One package tool, in the shape the MCP server registers it in.
 *
 * The packages write a zod object schema; the server takes the shape of
 * that schema, which is what the SDK builds the tool's arguments from. The
 * handler parses what the host sends and hands the tool what it expects,
 * so a call that does not fit the schema is refused with the reason.
 */
export function serverTool(name: string, def: PackageTool): ServerTool {
  const args = def.args;
  return {
    name,
    description: def.description,
    inputSchema: args instanceof z.ZodObject ? args.shape : {},
    async handler(input: unknown): Promise<McpToolResult> {
      const parsed = args.safeParse(input);
      if (!parsed.success) {
        return failure(`The arguments of ${name} do not fit the schema.`, parsed.error.message);
      }
      try {
        return text(await def.execute(parsed.data, SERVER_CONTEXT));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
