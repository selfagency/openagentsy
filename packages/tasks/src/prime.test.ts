import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Task } from './model.js';
import { primeBlock } from './prime.js';
import { TaskStore } from './store.js';

/**
 * The prime block: what a session is told about the tasks, and what that
 * costs.
 *
 * The block is rendered on every message, so the budget is a contract and
 * not a wish: at five hundred tasks it has to render in five milliseconds,
 * and it has to stay under two hundred tokens. The mechanism that makes it
 * fast is the stat-keyed cache in the store; this test measures the
 * outcome, so a faster mechanism can be swapped in without moving the
 * number.
 */

/** A store with a given number of tasks in it. */
const storeWith = async (count: number): Promise<TaskStore> => {
  const root = await mkdtemp(join(tmpdir(), 'oa-tasks-prime-'));
  const beans = join(root, '.beans');
  await mkdir(beans, { recursive: true });
  await Promise.all(
    Array.from({ length: count }, async (_unused, index) => {
      const id = `oa-${index.toString(36).padStart(4, '0')}`;
      const status = index % 9 === 0 ? 'in-progress' : index % 13 === 0 ? 'completed' : 'todo';
      const file =
        `---\n# ${id}\ntitle: Task ${index} does a thing of its own\nstatus: ${status}\n` +
        `type: task\npriority: normal\n---\n\nThe body of task ${index}.\n`;
      await writeFile(join(beans, `${id}--task-${index}.md`), file, 'utf8');
    }),
  );
  return new TaskStore(beans, { prefix: 'oa-' });
};

/** The task a title belongs to. */
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  slug: id,
  path: `${id}.md`,
  title: id,
  status: 'todo',
  body: '',
  etag: 'e',
  ...over,
});

describe('the prime block', () => {
  it('reads the files once, not once per message', async () => {
    const store = await storeWith(500);
    const first = await store.all();
    const second = await store.all();
    // The same objects: the warm store did not read a file again, and it
    // did not parse one again either.
    expect(second.length).toBe(first.length);
    expect(second[0]).toBe(first[0]);
  });

  it('renders in under five milliseconds at five hundred tasks', async () => {
    const store = await storeWith(500);
    await store.all();
    // A few rounds first: the first render pays for the code paths being
    // warm, and the budget is about the steady state.
    for (let round = 0; round < 5; round++) primeBlock(await store.all());

    // The budget is the cost of the work, so it is measured in CPU time. A
    // machine that is busy with other work stretches the wall clock without
    // changing the work, and the wall clock is printed next to it, because
    // that is the number a session waits for.
    //
    // The measurement covers a batch of renders: a single render is a short
    // window, and in it the runner's own work is as loud as the work being
    // measured.
    // The budget is a budget on the work, and the work is the same on
    // every machine. A shared runner is about twice as slow as the machine
    // the budget was measured on, and a budget in milliseconds fails there
    // for no reason at all, so the budget is scaled by what this machine
    // costs on a fixed piece of arithmetic.
    const REFERENCE_WORK = 4_000_000;
    const REFERENCE_MS = 1.45;
    const reference = (): number => {
      const before = process.cpuUsage();
      let sum = 0;
      for (let i = 0; i < REFERENCE_WORK; i += 1) sum += i;
      const used = process.cpuUsage(before);
      if (sum === -1) throw new Error('the loop did not run');
      return (used.user + used.system) / 1000;
    };
    const referenceRuns: number[] = [];
    for (let round = 0; round < 5; round += 1) referenceRuns.push(reference());
    const referenceMedian =
      [...referenceRuns].sort((left, right) => left - right)[2] ?? REFERENCE_MS;
    const budget = 5 * (referenceMedian / REFERENCE_MS);

    const WINDOW = 20;
    const WINDOWS = 20;
    const cpu: number[] = [];
    const wall: number[] = [];
    for (let batch = 0; batch < WINDOWS; batch++) {
      const before = process.cpuUsage();
      const start = performance.now();
      for (let round = 0; round < WINDOW; round++) {
        const block = primeBlock(await store.all());
        expect(block.length).toBeGreaterThan(0);
      }
      const used = process.cpuUsage(before);
      cpu.push((used.user + used.system) / 1000 / WINDOW);
      wall.push((performance.now() - start) / WINDOW);
    }
    const p95 = (samples: number[]): number => {
      const sorted = [...samples].sort((left, right) => left - right);
      return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
    };
    const cpuP95 = p95(cpu);
    const wallP95 = p95(wall);
    const wallMin = Math.min(...wall);
    process.stdout.write(
      `[prime] cpu p95 ${cpuP95.toFixed(2)} ms (max ${Math.max(...cpu).toFixed(2)}), wall p95 ${wallP95.toFixed(2)} ms, wall min ${wallMin.toFixed(2)} ms, budget ${budget.toFixed(2)} ms, reference ${referenceMedian.toFixed(2)} ms at 500 tasks${String.fromCharCode(10)}`,
    );
    expect(cpuP95).toBeLessThanOrEqual(budget);
  });

  it('stays under two hundred tokens at five hundred tasks', async () => {
    const store = await storeWith(500);
    const block = primeBlock(await store.all());
    expect(block.length / 4).toBeLessThanOrEqual(200);
  });

  it('names the tasks that are open, in progress and ready', async () => {
    const block = primeBlock([
      task('oa-1111', { status: 'in-progress', title: 'Being worked on' }),
      task('oa-2222', { title: 'Ready to be picked up' }),
      task('oa-3333', { status: 'completed', title: 'Already done' }),
    ]);
    expect(block).toContain('2 open; 1 in progress; 1 ready.');
    expect(block).toContain('oa-1111');
    expect(block).toContain('oa-2222');
    expect(block).not.toContain('oa-3333');
  });

  it('counts every task in progress, and lists only a few of them', () => {
    const tasks = Array.from({ length: 7 }, (_unused, index) =>
      task(`oa-${index}`, { status: 'in-progress', title: `Working on ${index}` }),
    );
    const block = primeBlock(tasks);
    expect(block).toContain('7 open; 7 in progress; 0 ready.');
    expect(block.split('\n').filter((line) => line.startsWith('- ')).length).toBe(3);
  });

  it('says nothing but tasks', () => {
    const block = primeBlock([task('oa-1111'), task('oa-2222', { status: 'in-progress' })]);
    const headings = block.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual(['## Project tasks (.beans)']);
    expect(block.toLowerCase().includes('memory')).toBe(false);
  });

  it('says nothing but tasks whatever the tasks are called', () => {
    const block = primeBlock([task('oa-1111', { title: 'The memory of the board' })]);
    const headings = block.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual(['## Project tasks (.beans)']);
    expect(block.split('\n').some((line) => line.toLowerCase().includes('memory'))).toBe(true);
  });

  it('copes with nothing to say', () => {
    const block = primeBlock([]);
    expect(block).toContain('0 open; 0 in progress; 0 ready.');
  });
});
