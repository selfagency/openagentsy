import { createOpenAI } from "@ai-sdk/openai"
import { judgeAgent, type JudgeAgent } from "@langwatch/scenario"

export type JudgeSetup = {
  agent: JudgeAgent
  model: string
}

/**
 * The judge, running on the user's own providers.
 *
 * The OpenCode server speaks the OpenAI chat completions API, so the judge
 * needs no second API key. The judge model is a different family from the
 * model under test, because a judge that runs on the same model tends to
 * agree with it.
 */
export function setupJudge(options: {
  baseUrl: string
  model: string
  criteria: string[]
}): JudgeSetup {
  const openai = createOpenAI({
    baseURL: `${options.baseUrl}/v1`,
    apiKey: "opencode",
  })

  return {
    model: options.model,
    agent: judgeAgent({
      criteria: options.criteria,
      model: openai(options.model),
    }),
  }
}
