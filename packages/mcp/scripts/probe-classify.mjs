#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
/**
 * The classifier probe.
 *
 * It calls the board's classification tool against the real service and
 * prints what came back, so a change to the client or to the profiles can be
 * seen rather than assumed.
 *
 *   TYPESAFE_API_KEY=... bun packages/mcp/scripts/probe-classify.mjs
 *
 * Without a key the probe says so and stops: there is nothing to check.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

if (!process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not set, so the classifier cannot be reached.');
  process.exit(1);
}

const REQUESTS = [
  'Fix a typo in README.md',
  'Audit this repo for security holes and report what you find, do not change any file',
  'Implement the user profile endpoint in packages/api/src/users.ts and its test',
  'Should the board use Postgres or SQLite? Give me three designs with trade-offs.',
];

const client = new Client({ name: 'classify-probe', version: '0.1.0' });
// The board reaches its database through bun:sqlite, so the server runs on
// bun. Node cannot load it.
await client.connect(new StdioClientTransport({ command: 'bun', args: [SERVER] }));

for (const request of REQUESTS) {
  const result = await client.callTool({
    name: 'board_classify',
    arguments: { request },
  });
  const text = result.content?.[0]?.text ?? '';
  const decision = JSON.parse(text);
  console.log(`\n${request}`);
  if (!decision.available) {
    console.log(`  no decision: ${decision.reason}`);
    continue;
  }
  console.log(`  ${decision.profile}  confidence ${decision.confidence}`);
  console.log(`  ${JSON.stringify(decision.probabilities)}`);
  console.log(`  ${decision.model}, ${decision.usage.input_tokens} input tokens`);
}

await client.close();
