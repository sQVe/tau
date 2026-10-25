import { execFile } from 'node:child_process';
import { symlink, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { TestContext } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

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
  cleanup: TestContext['onTestFinished'],
  testSource: string,
  hookTimeout = 1000,
  collectionTimeout = '3000',
): Promise<NestedRun> => {
  const directory = temporaryDirectory(cleanup, 'tau-hang-');

  await symlink(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'hanging.test.ts'), testSource);

  // Vitest projects ignore a --hookTimeout flag, so set the timeouts in a config they extend.
  await writeFile(
    join(directory, 'vite.config.ts'),
    [
      "import { mergeConfig } from 'vite-plus';",
      `import repository from ${JSON.stringify(join(repositoryRoot, 'vite.config.ts'))};`,
      `export default mergeConfig(repository, { test: { testTimeout: 1000, hookTimeout: ${hookTimeout} } });`,
    ].join('\n'),
  );

  const started = performance.now();

  return new Promise((resolve) => {
    execFile(
      join(repositoryRoot, 'node_modules', '.bin', 'vp'),
      ['test', '--root', directory, '--config', join(directory, 'vite.config.ts')],
      {
        env: { ...process.env, TAU_COLLECTION_TIMEOUT_MS: collectionTimeout },
        timeout: 25_000,
      },
      (error, stdout, stderr) => {
        resolve({
          failed: error !== null,
          seconds: (performance.now() - started) / 1000,
          // Vitest colors its output unless it detects an agent, which splits the names asserted below.
          output: stripVTControlCharacters(stdout + stderr),
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

  it('refuses a collection timeout that is not a positive whole number', async ({
    onTestFinished,
  }) => {
    const run = await runNested(
      onTestFinished,
      "import { it } from 'vitest'; it('runs', () => {});",
      1000,
      '-1',
    );

    expect(run.failed).toBe(true);
    expect(run.output).toContain('TAU_COLLECTION_TIMEOUT_MS must be a whole number');
    expect(run.output).not.toContain('Hang in');
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

  it('does not kill a blocking beforeEach within its own timeout', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeEach, it } from 'vitest'; ${blockingSleep}
beforeEach(() => { execFileSync('sleep', ['3']); }, 5000);
it('runs', () => {});`,
    );

    passes(run);
  });

  it('does not kill a blocking beforeAll within its own timeout', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeAll, it } from 'vitest'; ${blockingSleep}
beforeAll(() => { execFileSync('sleep', ['3']); }, 5000);
it('runs', () => {});`,
    );

    passes(run);
  });

  it('does not kill a nested blocking beforeAll that starts after a test', async ({
    onTestFinished,
  }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeAll, describe, it } from 'vitest'; ${blockingSleep}
it('runs first', () => {});
describe('nested', () => {
  beforeAll(() => { execFileSync('sleep', ['3']); }, 5000);
  it('runs', () => {});
});`,
    );

    passes(run);
  });

  it('kills a blocking beforeAll that runs past its own timeout', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeAll, it } from 'vitest'; ${blockingSleep}
beforeAll(() => { execFileSync('sleep', ['4']); }, 1500);
it('unreached', () => {});`,
    );

    hangs(run, 'hanging.test.ts (beforeAll hooks)');
  });

  it('does not kill a concurrent beforeAll that blocks after a sibling test finishes', async ({
    onTestFinished,
  }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeAll, describe, it } from 'vitest'; import { setTimeout } from 'node:timers/promises'; ${blockingSleep}
describe.concurrent('both', () => {
  describe('slow', () => {
    beforeAll(async () => { await setTimeout(500); execFileSync('sleep', ['3']); }, 5000);
    it('slow', () => {});
  });
  describe('fast', () => {
    it('fast', async () => { await setTimeout(100); });
  });
});`,
    );

    passes(run);
  });

  it('kills a blocked test before a suite with no hook timeout', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeAll, describe, it } from 'vitest'; ${blockingSleep}
it('blocks', () => { execFileSync('sleep', ['4']); });
describe('later', () => {
  beforeAll(() => {}, 0);
  it('runs', () => {});
});`,
    );

    hangs(run, 'hanging.test.ts > blocks');
  });

  it('kills a blocked test after a throwing beforeAll and afterAll', async ({ onTestFinished }) => {
    const run = await runNested(
      onTestFinished,
      `import { afterAll, beforeAll, describe, it } from 'vitest'; ${blockingSleep}
describe('failed setup', () => {
  beforeAll(() => { throw new Error('setup failed'); }, 0);
  afterAll(() => { throw new Error('cleanup failed'); });
  it('skipped', () => {});
});
describe('next suite', () => {
  it('blocks beyond timeout', () => { execFileSync('sleep', ['4']); }, 1000);
});`,
    );

    hangs(run, 'hanging.test.ts > blocks beyond timeout');
  });

  it('kills a blocking beforeAll when a skipped suite has no timeout', async ({
    onTestFinished,
  }) => {
    const run = await runNested(
      onTestFinished,
      `import { beforeAll, describe, it } from 'vitest'; ${blockingSleep}
beforeAll(() => { execFileSync('sleep', ['4']); }, 1500);
describe.skip('skipped', () => {
  beforeAll(() => {}, 0);
  it('unreached', () => {});
});
it('unreached', () => {});`,
    );

    hangs(run, 'hanging.test.ts (beforeAll hooks)');
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
