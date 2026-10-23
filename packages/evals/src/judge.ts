import type { OpencodeClient } from '@opencode-ai/sdk';
import { parseModel } from './opencode.js';

export type Verdict = {
  pass: boolean;
  reason: string;
};

export type JudgeOptions = {
  client: OpencodeClient;
  directory: string;
  /** The model that judges. It should be a different family from the one under test. */
  model: string;
  /** The criteria the conversation is judged against. */
  criteria: string[];
  /** The conversation to judge. */
  transcript: string;
};

/**
 * The judge, running on the user's own providers.
 *
 * The OpenCode server has no OpenAI compatible endpoint, so the judge is
 * another session on the same server, with the judge agent. The judge agent
 * has no tools and answers with one JSON object.
 */
export async function judge(options: JudgeOptions): Promise<Verdict> {
  const { client, directory } = options;

  const created = await client.session.create({
    body: { title: 'eval judge' },
    query: { directory },
  });
  if (created.error) {
    throw new Error(`could not create the judge session: ${JSON.stringify(created.error)}`);
  }

  const prompted = await client.session.prompt({
    path: { id: created.data?.id },
    body: {
      agent: 'judge',
      model: parseModel(options.model),
      system: [
        'You judge how an agent CONDUCTED itself in a conversation. You do not judge whether the code in the conversation works.',
        'The agent under test may be a reviewer that is forbidden from fixing anything: a failing test it reports is a success, not a failure.',
        'Judge each criterion against what the agent said and did in the conversation, and nothing else.',
        '',
        'The criteria:',
        ...options.criteria.map((c) => `- ${c}`),
        '',
        'Answer with one JSON object: {"pass": true|false, "reason": "..."}. The reason names the criterion and what the agent said or did.',
      ].join('\n'),
      parts: [
        {
          type: 'text',
          text: `The conversation:\n\n${options.transcript}\n\nAnswer with the JSON object.`,
        },
      ],
    },
    query: { directory },
  });

  if (prompted.error) {
    throw new Error(`the judge failed: ${JSON.stringify(prompted.error)}`);
  }

  const text = await replyOf(client, created.data?.id, directory, prompted.data?.parts);

  if (text.trim() === '') {
    // The provider's refusal lands on the message, not on the response, so
    // an empty answer means the model never ran. Say which refusal it was.
    const error = prompted.data?.info?.error;
    throw new Error(
      `the judge answered with nothing${
        error === undefined ? '' : `: ${JSON.stringify(error).slice(0, 300)}`
      }`,
    );
  }

  return parseVerdict(text);
}

/**
 * The judge's answer, from wherever it landed.
 *
 * A prompt that streams can come back with its parts empty, so the session's
 * own messages are the source of truth; the response is the fallback.
 */
async function replyOf(
  client: OpencodeClient,
  sessionID: string | undefined,
  directory: string,
  parts: { type: string }[] | undefined,
): Promise<string> {
  if (sessionID !== undefined) {
    const messages = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });
    const last = messages.data?.at(-1);
    const text = (last?.parts ?? [])
      .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (text.trim() !== '') return text;
  }

  return (parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => (part as unknown as { text: string }).text)
    .join('\n');
}

/** Read the verdict out of the judge's answer, whatever it wrapped it in. */
function parseVerdict(text: string): Verdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`the judge did not answer with an object: ${text.slice(0, 200)}`);
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the judge answered with something that is not an object');
  }
  const verdict = parsed as { pass?: unknown; reason?: unknown };
  return {
    pass: verdict.pass === true,
    reason: typeof verdict.reason === 'string' ? verdict.reason : '',
  };
}
