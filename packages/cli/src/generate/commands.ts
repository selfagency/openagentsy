import type { Target } from '@openagentsy/core';
import { stringify } from 'yaml';

export type CommandDefinition = {
  name: string;
  description: string;
  agent: string;
  /** true runs the command as a background child session, false runs it inline. */
  background: boolean;
  template: string;
};

export const COMMANDS: CommandDefinition[] = [
  {
    name: 'plan',
    description: 'Classify a request, write the plan as beans, and stop for approval.',
    agent: 'oa-lead',
    background: false,
    template: [
      'Classify this request before doing anything: size, decomposability, risk,',
      'and mode. Solo, fan-out read, parallel write, or design options.',
      '',
      'Write the plan as beans. Each bean states objective, acceptance tests,',
      'owned globs, inputs, output format, budget, and blockedBy.',
      '',
      'Present the plan and stop. Do not start work before the plan is approved.',
    ].join('\n'),
  },
  {
    name: 'review',
    description: "Review the active bean's diff against its acceptance criteria.",
    agent: 'oa-reviewer',
    background: true,
    template: [
      'Review the current diff for the active bean against its acceptance',
      'criteria. You see the diff and the criteria, not the history of how the',
      'change was written.',
      '',
      'Run the tests and the inspection pass first, then report findings in',
      'severity order with file, line, and a concrete reproduction for each.',
      '',
      'Do not fix anything. Post the findings as a board record.',
    ].join('\n'),
  },
  {
    name: 'status',
    description: 'Report open beans, leases, budget spend, and the last records per bean.',
    agent: 'oa-lead',
    background: false,
    template: [
      'Report the state of the board: open beans, who holds each file lease,',
      'tokens spent against each bean budget, and the most recent records per',
      'bean.',
      '',
      'Separate what is verified from what is inferred.',
    ].join('\n'),
  },
];

export function renderCommand(command: CommandDefinition, target: Target): string {
  const frontmatter: Record<string, unknown> = {
    description: command.description,
    agent: command.agent,
  };
  // V1 calls the flag `subtask`, V2 calls it `subagent` and still accepts
  // `subtask` as a deprecated alias.
  frontmatter[target === 'v1' ? 'subtask' : 'subagent'] = command.background;

  return `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${command.template}\n`;
}
