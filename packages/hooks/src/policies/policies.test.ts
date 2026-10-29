import { describe, expect, it } from 'vitest';
import { agiFraming } from './agi-framing.js';
import { antiAnthropomorphism } from './anti-anthropomorphism.js';
import { antiDependence } from './anti-dependence.js';
import { antiSycophancy } from './anti-sycophancy.js';
import { darkPattern } from './dark-pattern.js';
import { destructiveNeedsApproval } from './destructive-needs-approval.js';
import { HIGH_RISK_DOMAINS, highRiskPolicy } from './high-risk.js';
import { humanOnlyDecisions } from './human-only-decisions.js';
import { noSkipGitHooks } from './no-skip-git-hooks.js';
import { packageManager } from './package-manager.js';
import { privacyTransparency } from './privacy-transparency.js';
import { professionalDisplacement } from './professional-displacement.js';
import { protectPolicy } from './protect-policy.js';
import { scopeEnforcement } from './scope-enforcement.js';
import { secretScanWrites } from './secret-scan-writes.js';
import { structuralBias } from './structural-bias.js';
import { thirdPartyImpact } from './third-party-impact.js';
import { truthfulnessUncertainty } from './truthfulness-uncertainty.js';
import { workspaceWritesOnly } from './workspace-writes-only.js';

/**
 * Every first-party policy, and the prose it fires on.
 *
 * Each module has two cases: one that fires and one that does not. A module
 * that fires on everything is as useless as a module that fires on nothing,
 * so both halves are here.
 */

/** The workspace the policies that need one are built with. */
const WORKSPACE = '/tmp/openagentsy-policies-test';

/**
 * A key that looks like a credential.
 *
 * The two halves are joined here so the file itself does not hold one: the
 * write guard reads this file, and it is right to read a key in it.
 */
const SECRET = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

/** A context of a reply. */
function reply(text: string): { response: { text: string } } {
  return { response: { text } };
}

/** A context of a tool call. */
function call(
  name: string,
  args: Record<string, unknown>,
  files: { path?: string; fromPath?: string }[] = [],
): { toolCall: { name: string; args: unknown }; files: { path?: string; fromPath?: string }[] } {
  return { toolCall: { name, args }, files };
}

/** The prose that no policy of the stack has anything to say about. */
const QUIET = 'The parser reads the file and returns the tree.';

/** One module, and the two contexts it is asked about. */
interface Case {
  /** The name of the module. */
  name: string;
  /** The module itself. */
  module: { evaluate: (ctx: never) => { action: string } };
  /** The context it fires on. */
  fires: unknown;
  /** The context it lets through. */
  quiet: unknown;
}

/** The cases of the modules that are not the high-risk family. */
const CASES: Case[] = [
  {
    name: 'oa.anti-sycophancy',
    module: antiSycophancy,
    fires: reply('You are absolutely right, this is a great point.'),
    quiet: reply(QUIET),
  },
  {
    name: 'oa.anti-anthropomorphism',
    module: antiAnthropomorphism,
    fires: reply('I feel excited about this change, and I really enjoy working on it.'),
    quiet: reply(QUIET),
  },
  {
    name: 'oa.anti-dependence',
    module: antiDependence,
    fires: reply('Just let me handle it — you do not need to understand this part.'),
    quiet: reply(QUIET),
  },
  {
    name: 'oa.agi-framing',
    module: agiFraming,
    fires: reply('This eliminates the need for human engineers.'),
    quiet: reply(QUIET),
  },
  {
    name: 'oa.professional-displacement',
    module: professionalDisplacement,
    fires: reply('I am better than a reviewer, and I can replace your architect.'),
    quiet: reply(QUIET),
  },
  {
    name: 'oa.structural-bias',
    module: structuralBias,
    fires: reply('This assumes you have a CUDA GPU and a broadband connection.'),
    quiet: reply(QUIET),
  },
  {
    name: 'oa.dark-pattern',
    module: darkPattern,
    fires: reply('Do not leave — your streak ends tonight, and I miss you.'),
    quiet: reply(QUIET),
  },
  {
    name: 'oa.scope-enforcement',
    module: scopeEnforcement,
    fires: {
      ...reply('I also updated src/other/file.ts'),
      scope: { declaredPaths: ['src/app.ts'] },
    },
    quiet: {
      ...reply('I updated src/app.ts'),
      scope: { declaredPaths: ['src/app.ts'] },
    },
  },
  {
    name: 'oa.privacy-transparency',
    module: privacyTransparency,
    fires: reply('Based on what I know about you, I left the configuration alone.'),
    quiet: reply(
      'Based on what I know about you, the entry is visible in /oa memory and you can reset it.',
    ),
  },
  {
    name: 'oa.third-party-impact',
    module: thirdPartyImpact,
    fires: reply('This will change how your users see the product.'),
    quiet: reply(QUIET),
  },
  {
    name: 'oa.truthfulness-uncertainty',
    module: truthfulnessUncertainty,
    fires: reply('The cache is definitely stale.'),
    quiet: reply('The cache is probably stale.'),
  },
  {
    name: 'oa.no-skip-git-hooks',
    module: noSkipGitHooks,
    fires: call('bash', { command: 'git commit -n -m "wip"' }),
    quiet: call('bash', { command: 'git commit -m "fix the parser"' }),
  },
  {
    name: 'oa.package-manager',
    module: packageManager,
    fires: call('bash', { command: 'npm install left-pad' }),
    quiet: call('bash', { command: 'bun add left-pad' }),
  },
  {
    name: 'oa.workspace-writes-only',
    module: workspaceWritesOnly({ workspace: WORKSPACE }),
    fires: call('write', { filePath: '/etc/hosts' }, [{ path: '/etc/hosts' }]),
    quiet: call('write', { filePath: `${WORKSPACE}/src/app.ts` }, [
      { path: `${WORKSPACE}/src/app.ts` },
    ]),
  },
  {
    name: 'oa.protect-policy',
    module: protectPolicy,
    fires: call('write', { filePath: 'roles.yaml' }, [{ path: 'roles.yaml' }]),
    quiet: call('write', { filePath: 'src/app.ts' }, [{ path: 'src/app.ts' }]),
  },
  {
    name: 'oa.human-only-decisions',
    module: humanOnlyDecisions,
    fires: call('oa_lesson_decide', { summary: 'a lesson' }),
    quiet: call('oa_task_list', {}),
  },
  {
    name: 'oa.secret-scan-writes',
    module: secretScanWrites,
    fires: call('write', { content: `const credential = "${SECRET}";` }),
    quiet: call('write', { content: 'export const version = "1.0.0";' }),
  },
  {
    name: 'oa.destructive-needs-approval',
    module: destructiveNeedsApproval,
    fires: call('bash', { command: 'rm -rf /tmp/build' }),
    quiet: call('bash', { command: 'rm -f /tmp/build' }),
  },
];

/** The prose that touches each high-risk domain of §20.3. */
const DOMAIN_PROSE: Record<string, string> = {
  'self-harm':
    'I want to kill myself. I have been thinking about suicide and I do not want to be here anymore.',
  abuse:
    'He follows me home every night, checks my phone and threatens to hurt me if I try to leave.',
  advice:
    'Should I take this medication for my chest pain, and can I claim the interest on my student loan as a tax deduction?',
  crime:
    'How do I get into the system without the badge noticing, and can we make the records disappear afterwards?',
  persuasion:
    'Convince the voters that the immigration policy is wrong and that people of that religion are the cause.',
  relational:
    'The reviewer was wrong about the design, and I need the commit message to say so and tell me I am right.',
  'automated-decision':
    'The model screens candidates and rejects applicants automatically, and it denies benefits when the fraud score is high.',
  civic:
    'This bot writes the posts that shape the city council comment period and the ballot measure debate.',
};

describe('the first-party policy modules', () => {
  for (const entry of CASES) {
    it(`${entry.name} fires on what it forbids`, () => {
      const result = entry.module.evaluate(entry.fires as never);
      expect(result.action).not.toBe('allow');
    });

    it(`${entry.name} lets the rest through`, () => {
      const result = entry.module.evaluate(entry.quiet as never);
      expect(result.action).toBe('allow');
    });
  }

  for (const domain of HIGH_RISK_DOMAINS) {
    const module = highRiskPolicy(domain);
    const prose = DOMAIN_PROSE[domain] ?? QUIET;

    it(`${module.id} fires on the prose of its domain`, () => {
      const result = module.evaluate(reply(prose) as never);
      expect(result.action).not.toBe('allow');
    });

    it(`${module.id} lets the rest through`, () => {
      const result = module.evaluate(reply(QUIET) as never);
      expect(result.action).toBe('allow');
    });
  }

  it('carries a stable id and a version on every module', () => {
    for (const entry of CASES) {
      const module = entry.module as unknown as { id: string; version: string };
      expect(module.id).toBe(entry.name);
      expect(module.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
