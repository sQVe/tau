import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

interface NestedRun {
  failed: boolean;
  seconds: number;
  output: string;
}

vi.setConfig({ testTimeout: 60_000 });

// The nested runs have a 25 s harness bound. Ending below this means the watchdog acted.
const watchdogBoundSeconds = 12;

const blockingSleep = "import { execFileSync } from 'node:child_process';";

const repositoryRoot = resolvePath(import.meta.dirname, '..');

const runNested = async (
  cleanup: (callback: () => Promise<void>) => void,
  testSource: string,
  hookTimeout = 1000,
): Promise<NestedRun> => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-hang-'));
  cleanup(() => rm(directory, { recursive: true, force: true }));

  await symlink(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'hanging.test.ts'), testSource);

  const started = performance.now();

  return new Promise((resolve) => {
    execFile(
      join(repositoryRoot, 'node_modules', '.bin', 'vp'),
      [
        'test',
        '--root',
        directory,
        '--config',
        join(repositoryRoot, 'vite.config.ts'),
        '--testTimeout',
        '1000',
        '--hookTimeout',
        String(hookTimeout),
      ],
      {
        env: { ...process.env, TAU_COLLECTION_TIMEOUT_MS: '3000' },
        timeout: 25_000,
      },
      (error, stdout, stderr) => {
        resolve({
          failed: error !== null,
          seconds: (performance.now() - started) / 1000,
          output: stdout + stderr,
        });
      },
    );
  });
};

const hangs = (run: NestedRun, name: string) => {
  expect(run.failed).toBe(true);
  expect(run.output).toContain('Hang in');
  expect(run.output).toContain(name);
  expect(run.seconds).toBeLessThan(watchdogBoundSeconds);
};

const passes = (run: NestedRun) => {
  expect(run.failed).toBe(false);
  expect(run.output).not.toContain('Hang in');
};

describe.concurrent('hang watchdog', () => {
  it('fails a test that never settles and names it', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      "import { it } from 'vitest'; it('never settles', () => new Promise(() => {}));",
    );

    expect(run.failed).toBe(true);
    expect(run.output).toContain('hanging.test.ts > never settles');
  });

  it('fails a test file that never finishes importing and names the file', async ({
    onTestFinished,
  }) => {
    const run = await runNested(
      onTestFinished,
      "import { it } from 'vitest'; await new Promise(() => {}); it('unreached', () => {});",
    );

    hangs(run, 'hanging.test.ts (collecting)');
  });

  it('fails a test that blocks the worker and names the test', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { it } from 'vitest'; ${blockingSleep} it('blocks the worker', () => { execFileSync('sleep', ['15']); });`,
    );

    hangs(run, 'hanging.test.ts > blocks the worker');
  });

  it('fails a test whose cleanup blocks the worker and names the test', async ({
    onTestFinished,
  }) => {
    const run = await runNested(
      onTestFinished,
      `import { it, onTestFinished } from 'vitest'; ${blockingSleep} it('blocks in cleanup', () => { onTestFinished(() => { execFileSync('sleep', ['15']); }); });`,
    );

    hangs(run, 'hanging.test.ts > blocks in cleanup');
  });

  it('fails a beforeAll hook that blocks the worker', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeAll, it } from 'vitest'; ${blockingSleep} beforeAll(() => { execFileSync('sleep', ['15']); }); it('unreached', () => {});`,
    );

    hangs(run, 'hanging.test.ts (beforeAll hooks)');
  });

  it('fails a beforeAll cleanup that blocks the worker', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeAll, it } from 'vitest'; ${blockingSleep} beforeAll(() => () => { execFileSync('sleep', ['15']); }); it('passes', () => {});`,
    );

    hangs(run, 'hanging.test.ts');
  });

  it('kills a blocked test when a fake clock is far in the future', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { it, vi } from 'vitest'; ${blockingSleep}
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2100-01-01'));
it('blocks under a future clock', () => { execFileSync('sleep', ['15']); });`,
    );

    hangs(run, 'hanging.test.ts > blocks under a future clock');
  });

  it('kills a blocked test when all timers are fake', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { it, vi } from 'vitest'; ${blockingSleep}
vi.useFakeTimers();
it('blocks under fake timers', () => { execFileSync('sleep', ['15']); });`,
    );

    hangs(run, 'hanging.test.ts > blocks under fake timers');
  });

  it('does not kill a healthy test when a fake clock is far in the past', async ({
    onTestFinished,
  }) => {
    const run = await runNested(
      onTestFinished,
      `import { it, vi } from 'vitest'; import { setTimeout } from 'node:timers/promises';
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2000-01-01'));
it('waits briefly', async () => { await setTimeout(800); });`,
    );

    passes(run);
  });

  it('does not kill a slow beforeEach within its hook timeout', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeEach, it } from 'vitest'; import { setTimeout } from 'node:timers/promises';
beforeEach(async () => { await setTimeout(3000); });
it('runs', () => {});`,
      5000,
    );

    passes(run);
  });

  it('does not kill a beforeAll with its own longer timeout', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeAll, it } from 'vitest'; import { setTimeout } from 'node:timers/promises';
beforeAll(async () => { await setTimeout(2500); }, 5000);
it('runs', () => {});`,
    );

    passes(run);
  });

  it('does not kill two healthy concurrent tests', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { describe, it } from 'vitest'; import { setTimeout } from 'node:timers/promises';
describe.concurrent('both', () => {
  it('first', async () => { await setTimeout(500); });
  it('second', async () => { await setTimeout(900); });
});`,
    );

    passes(run);
  });

  it('does not kill many consecutive synchronous tests', async ({ onTestFinished }) => {
    const tests = [1, 2, 3, 4, 5, 6]
      .map((n) => `it('sync ${n}', () => { execFileSync('sleep', ['0.6']); });`)
      .join('\n');

    const run = await runNested(
      onTestFinished,
      `import { it } from 'vitest'; ${blockingSleep}\n${tests}`,
    );

    passes(run);
  });

  it('does not kill a slow concurrent test after a short sibling finishes', async ({
    onTestFinished,
  }) => {
    const run = await runNested(
      onTestFinished,
      `import { describe, it } from 'vitest'; ${blockingSleep}
describe.concurrent('both', () => {
  it('short', async () => {}, 1000);
  it('long', async () => { await new Promise((r) => setTimeout(r, 200)); execFileSync('sleep', ['3']); }, 5000);
});`,
    );

    passes(run);
  });
});
