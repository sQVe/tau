import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { expect, it, vi } from 'vitest';

// Each test spawns a nested Vitest run, which took 5.2 s to 8.0 s with every CPU busy. The nested
// run has its own 25 s bound, so this timeout must stay above that bound.
vi.setConfig({ testTimeout: 60_000 });

const repositoryRoot = resolvePath(import.meta.dirname, '..');

const probeDirectories = (prefix: string): string[] => {
  const prefixes = [`tau-${prefix}-target-`, `tau-${prefix}-agent-`, `tau-${prefix}-extra-`];

  return readdirSync(tmpdir()).filter((entry) =>
    prefixes.some((probePrefix) => entry.startsWith(probePrefix)),
  );
};

const removeProbeDirectories = (prefix: string): void => {
  for (const entry of probeDirectories(prefix)) {
    rmSync(join(tmpdir(), entry), { recursive: true, force: true });
  }
};

const runNested = (directory: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      join(repositoryRoot, 'node_modules', '.bin', 'vitest'),
      ['run', '--config', join(directory, 'vitest.config.mjs')],
      { cwd: directory, timeout: 25_000 },
      (error) => {
        resolve(error === null);
      },
    );
  });

// Starts a nested run that waits for a signal, then sends SIGHUP to its live worker. Returns the
// worker PID so the test can assert it terminated before checking the directories.
const runNestedWithSignal = (
  directory: string,
  onTestFinished: (cleanup: () => void) => void,
): Promise<number> => {
  const child = spawn(
    join(repositoryRoot, 'node_modules', '.bin', 'vitest'),
    ['run', '--config', join(directory, 'vitest.config.mjs')],
    { cwd: directory, stdio: 'ignore' },
  );

  const pidFile = join(directory, 'signal.pid');

  onTestFinished(() => {
    child.kill('SIGKILL');
  });

  return new Promise((resolve, reject) => {
    let workerPid = 0;

    const poll = setInterval(() => {
      if (!existsSync(pidFile)) {
        return;
      }

      clearInterval(poll);
      workerPid = Number(readFileSync(pidFile, 'utf8'));

      try {
        process.kill(workerPid, 'SIGHUP');
      } catch (error) {
        reject(new Error(`Could not signal the nested worker: ${String(error)}`));
      }
    }, 10);

    const timeout = setTimeout(() => {
      clearInterval(poll);
      child.kill('SIGKILL');
      reject(new Error('The nested suite did not report its worker PID.'));
    }, 20_000);

    child.once('error', (error) => {
      clearInterval(poll);
      clearTimeout(timeout);
      reject(error);
    });

    child.once('exit', () => {
      clearInterval(poll);
      clearTimeout(timeout);
      resolve(workerPid);
    });
  });
};

const nestedSuiteSource = (
  prefix: string,
  outcome: 'pass' | 'fail' | 'exit' | 'signal',
): string => {
  const lines = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { beforeAll, expect, it, vi } from 'vitest';",
    `import { useSharedCargoEnvironment } from ${JSON.stringify(join(repositoryRoot, 'tests', 'nextestHarness.js'))};`,
    `import { suiteCleanup, temporaryDirectory } from ${JSON.stringify(join(repositoryRoot, 'tests', 'temporaryDirectoryHarness.js'))};`,
    '',
    'vi.setConfig({ testTimeout: 60_000 });',
    '',
    `useSharedCargoEnvironment(${JSON.stringify(prefix)});`,
    '',
    'const registerCleanup = suiteCleanup();',
    "let extraDirectory = '';",
    '',
    'beforeAll(() => {',
    `  extraDirectory = temporaryDirectory(registerCleanup, ${JSON.stringify(`tau-${prefix}-extra-`)});`,
    "  writeFileSync(join(extraDirectory, 'ran.txt'), 'ran');",
    '});',
    '',
    'registerCleanup(() => {',
    "  const seen = existsSync(join(import.meta.dirname, 'async-cleanup.marker')) ? 'after' : 'early';",
    "  writeFileSync(join(import.meta.dirname, 'order.marker'), seen);",
    '});',
    '',
    'registerCleanup(async () => {',
    '  await new Promise((resolve) => setImmediate(resolve));',
    "  writeFileSync(join(import.meta.dirname, 'async-cleanup.marker'), 'ran');",
    '});',
    '',
    "it('creates the shared directories', () => {",
    '  const targetDirectory = process.env.CARGO_TARGET_DIR;',
    '  expect(targetDirectory).toBeDefined();',
    "  writeFileSync(join(targetDirectory as string, 'ran.txt'), 'ran');",
    "  writeFileSync(join(extraDirectory, 'ran.txt'), 'ran');",
    "  writeFileSync(join(import.meta.dirname, 'ran.marker'), 'ran');",
    '});',
  ];

  if (outcome === 'fail') {
    lines.push(
      '',
      "it('fails after the directories exist', () => {",
      '  expect(1).toBe(2);',
      '});',
    );
  }

  if (outcome === 'exit') {
    lines.push(
      '',
      "it('exits before the suite cleanup runs', () => {",
      '  process.exit(0);',
      '});',
    );
  }

  if (outcome === 'signal') {
    lines.push(
      '',
      "it('waits for a signal before the suite cleanup runs', async () => {",
      "  writeFileSync(join(import.meta.dirname, 'signal.pid'), String(process.pid));",
      '  await new Promise(() => {});',
      '});',
    );
  }

  return lines.join('\n');
};

const createNestedSuite = (
  onTestFinished: (cleanup: () => void) => void,
  outcome: 'pass' | 'fail' | 'exit' | 'signal',
): { directory: string; prefix: string } => {
  const prefix = `harness-leak-${randomUUID()}`;
  const directory = join(tmpdir(), `tau-${prefix}-nested-`);

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
    removeProbeDirectories(prefix);
  });

  mkdirSync(directory, { recursive: true });
  symlinkSync(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');

  writeFileSync(
    join(directory, 'vitest.config.mjs'),
    `export default { root: ${JSON.stringify(directory)}, test: { include: ['*.test.ts'] } };\n`,
  );

  writeFileSync(
    join(directory, 'sharedCargoEnvironment.test.ts'),
    nestedSuiteSource(prefix, outcome),
  );

  return { directory, prefix };
};

const runSuite = async (
  onTestFinished: (cleanup: () => void) => void,
  outcome: 'pass' | 'fail' | 'exit',
): Promise<{ directory: string; prefix: string; succeeded: boolean }> => {
  const { directory, prefix } = createNestedSuite(onTestFinished, outcome);

  return { directory, prefix, succeeded: await runNested(directory) };
};

const expectCleanSuite = async (
  onTestFinished: (cleanup: () => void) => void,
  outcome: 'pass' | 'fail',
): Promise<void> => {
  const { directory, prefix, succeeded } = await runSuite(onTestFinished, outcome);

  expect(existsSync(join(directory, 'ran.marker'))).toBe(true);
  expect(existsSync(join(directory, 'async-cleanup.marker'))).toBe(true);
  expect(readFileSync(join(directory, 'order.marker'), 'utf8')).toBe('after');
  expect(succeeded).toBe(outcome === 'pass');
  expect(probeDirectories(prefix)).toEqual([]);
};

it('removes the shared cargo directories when a failing suite exits', async ({
  onTestFinished,
}) => {
  await expectCleanSuite(onTestFinished, 'fail');
});

it('removes the shared cargo directories when a passing suite exits', async ({
  onTestFinished,
}) => {
  await expectCleanSuite(onTestFinished, 'pass');
});

it('removes the shared cargo directories when a suite exits before its cleanup runs', async ({
  onTestFinished,
}) => {
  const { directory, prefix } = await runSuite(onTestFinished, 'exit');

  expect(existsSync(join(directory, 'ran.marker'))).toBe(true);
  expect(probeDirectories(prefix)).toEqual([]);
});

it('removes the shared cargo directories when a live suite is killed before its cleanup runs', async ({
  onTestFinished,
}) => {
  const { directory, prefix } = createNestedSuite(onTestFinished, 'signal');
  const workerPid = await runNestedWithSignal(directory, onTestFinished);

  expect(existsSync(join(directory, 'ran.marker'))).toBe(true);
  expect(() => process.kill(workerPid, 0)).toThrow('ESRCH');
  expect(probeDirectories(prefix)).toEqual([]);
});
