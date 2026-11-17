import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { expect, it } from 'vitest';

const repositoryRoot = resolvePath(import.meta.dirname, '..');

const probeDirectories = (prefix: string): string[] => {
  const prefixes = [`tau-${prefix}-target-`, `tau-${prefix}-agent-`];

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

it('removes the shared cargo directories when a failing suite exits', async ({
  onTestFinished,
}) => {
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
    [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { expect, it } from 'vitest';",
      `import { useSharedCargoEnvironment } from ${JSON.stringify(join(repositoryRoot, 'tests', 'nextestHarness.js'))};`,
      '',
      `useSharedCargoEnvironment(${JSON.stringify(prefix)});`,
      '',
      "it('creates the shared directories', () => {",
      '  const targetDirectory = process.env.CARGO_TARGET_DIR;',
      '  expect(targetDirectory).toBeDefined();',
      "  writeFileSync(join(targetDirectory as string, 'ran.txt'), 'ran');",
      "  writeFileSync(join(import.meta.dirname, 'ran.marker'), 'ran');",
      '});',
      '',
      "it('fails after the directories exist', () => {",
      '  expect(1).toBe(2);',
      '});',
      '',
    ].join('\n'),
  );

  const succeeded = await runNested(directory);

  expect(existsSync(join(directory, 'ran.marker'))).toBe(true);
  expect(succeeded).toBe(false);
  expect(probeDirectories(prefix)).toEqual([]);
});
