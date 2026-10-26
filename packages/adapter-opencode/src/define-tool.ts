import { z } from 'zod';
import { type ToolArgs, type ToolDefinition, tool } from './tool.js';

/**
 * One tool, defined once.
 *
 * The args are a zod schema, so the same definition gives the V1 plugin the
 * shape it builds its object from and the V2 plugin the JSON schema it
 * publishes. The execute callback is a method and not a property, because a
 * method is compared bivariantly: a definition with a concrete schema then
 * fits a map of erased ones.
 */
export interface ToolDef<A extends z.ZodType> {
  description: string;
  args: A;
  execute(args: z.infer<A>, ctx: ToolCtx): Promise<unknown>;
}

/** The context the V1 tool helper hands to an execute callback. */
export type V1ToolCtx = Parameters<ToolDefinition['execute']>[1];

/**
 * The context a definition is written against.
 *
 * The two runtimes hand over different things. V1 gives the session, the
 * agent, the message, the directory, the worktree, an abort signal and a
 * metadata sink; V2 gives the session, the agent and a signal. The session
 * and the agent are what both of them give, so a definition counts on those
 * two and on nothing else. The rest of what a tool needs, the root it works
 * on, it takes from the closure the registration builds.
 */
export type ToolCtx = Pick<V1ToolCtx, 'sessionID' | 'agent'>;

/**
 * One definition, two runtimes: V1's tool() shape and V2's registration.
 *
 * The function is the identity on purpose. The type parameter is what
 * carries the argument type from the schema to the callback, and a helper
 * that took the schema alone would lose it.
 */
export function defineTool<A extends z.ZodType>(def: ToolDef<A>): ToolDef<A> {
  return def;
}

/**
 * The V1 plugin's tool map.
 *
 * The V1 plugin takes a map of tool name to definition, and the host builds
 * the object it validates against from the shape. A definition keeps the
 * schema whole, so the shape is taken out of it here.
 */
export function toolMap(defs: Record<string, ToolDef<z.ZodType>>): Record<string, ToolDefinition> {
  const map: Record<string, ToolDefinition> = {};
  for (const [name, def] of Object.entries(defs)) {
    const args: ToolArgs = shapeOf(def.args);
    map[name] = tool({
      description: def.description,
      args,
      execute: async (parsed, ctx) => {
        const result = await def.execute(parsed, ctx);
        return typeof result === 'string' ? result : String(result);
      },
    });
  }
  return map;
}

/** The V2 plugin's tool definition. */
export type V2ToolDefinition = {
  name: string;
  description: string;
  input: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  execute: (
    input: unknown,
    context: { sessionID: string; agent?: string; signal?: AbortSignal },
  ) => Promise<{ content: string }>;
};

/**
 * The V2 registration of one definition.
 *
 * The V2 plugin takes a JSON schema and a tool that returns structured
 * content, so the schema comes out of the zod one and the result is
 * wrapped. The host hands the raw input over, so the input is checked
 * against the schema here and the definition still sees what it expects.
 */
export function v2Tool(name: string, def: ToolDef<z.ZodType>): V2ToolDefinition {
  return {
    name,
    description: def.description,
    input: jsonSchema(def.args),
    execute: async (input, context) => {
      const parsed = def.args.safeParse(input);
      const result = await def.execute(parsed.success ? parsed.data : input, {
        sessionID: context.sessionID,
        agent: context.agent ?? '',
      });
      return { content: String(result) };
    },
  };
}

/**
 * The shape the V1 plugin takes, taken out of the schema.
 *
 * A schema that is not an object has no shape, and an empty one is what
 * the V1 plugin would build from it anyway.
 */
function shapeOf(args: z.ZodType): ToolArgs {
  if (!(args instanceof z.ZodObject)) return {};
  return args.shape as ToolArgs;
}

/** The JSON schema the V2 plugin publishes, taken out of the zod schema. */
function jsonSchema(args: z.ZodType): V2ToolDefinition['input'] {
  const schema = z.toJSONSchema(args);
  return {
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required ?? [],
    additionalProperties: false,
  };
}
