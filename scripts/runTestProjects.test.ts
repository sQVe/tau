import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.ts';

interface Sandbox {
  root: string;
  binDirectory: string;
  recordPath: string;
}

interface Run {
  status: number | null;
  stderr: string;
}

const script = join(import.meta.dirname, 'runTestProjects.ts');

// Whole seconds keep the modification time exact, so a rewrite that restores the time matches the first run.
const fixedTime = new Date('2001-09-09T01:46:40Z');

const nodeDirectory = dirname(process.execPath);

const createSandbox = (): Sandbox => {
  const root = temporaryDirectory(onTestFinished, 'tau-run-test-projects-');

  return { root, binDirectory: join(root, 'bin'), recordPath: join(root, 'vp-record') };
};

const installFakeVp = async (sandbox: Sandbox, exitStatus: number) => {
  const path = join(sandbox.binDirectory, 'vp');

  await mkdir(sandbox.binDirectory, { recursive: true });

  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s' "$TAU_PATH_COMMANDS" > '${sandbox.recordPath}'\nexit ${exitStatus}\n`,
  );

  await chmod(path, 0o755);
  await utimes(path, fixedTime, fixedTime);
};

const pathWith = (directories: string[]) => directories.join(delimiter);

const runTestProjects = (path: string): Run => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: path } });

  return { status: result.status, stderr: result.stderr };
};

const readRecord = (sandbox: Sandbox) => readFile(sandbox.recordPath, 'utf8');

it('digests a normal PATH as a sha256 hex string', async () => {
  const sandbox = createSandbox();
  await installFakeVp(sandbox, 0);

  runTestProjects(pathWith([sandbox.binDirectory, nodeDirectory]));

  expect(await readRecord(sandbox)).toMatch(/^[0-9a-f]{64}$/);
});

it('keeps the digest when PATH repeats its directories', async () => {
  const sandbox = createSandbox();
  await installFakeVp(sandbox, 0);
  const path = pathWith([sandbox.binDirectory, nodeDirectory]);

  runTestProjects(path);
  const single = await readRecord(sandbox);

  runTestProjects(`${path}${delimiter}${path}`);

  expect(await readRecord(sandbox)).toBe(single);
});

it('changes the digest when an executable is rewritten with the same size and mtime', async () => {
  const sandbox = createSandbox();
  await installFakeVp(sandbox, 0);
  const path = pathWith([sandbox.binDirectory, nodeDirectory]);

  runTestProjects(path);
  const before = await readRecord(sandbox);

  await installFakeVp(sandbox, 1);
  runTestProjects(path);

  expect(await readRecord(sandbox)).not.toBe(before);
});

it.skipIf(process.getuid?.() === 0)(
  'passes a random unlistable value and names the directory when a PATH directory cannot be listed',
  async () => {
    const sandbox = createSandbox();
    await installFakeVp(sandbox, 0);
    const unlistableDirectory = join(sandbox.root, 'unlistable');
    await mkdir(unlistableDirectory);
    await chmod(unlistableDirectory, 0o111);
    const path = pathWith([unlistableDirectory, sandbox.binDirectory, nodeDirectory]);

    const first = runTestProjects(path);
    const firstRecord = await readRecord(sandbox);
    const second = runTestProjects(path);
    const secondRecord = await readRecord(sandbox);
    await chmod(unlistableDirectory, 0o755);

    expect(firstRecord).toMatch(/^unlistable-/);
    expect(secondRecord).not.toBe(firstRecord);
    expect(first.stderr).toContain(`Cannot list PATH directory ${unlistableDirectory}`);
    expect(second.status).toBe(0);
  },
);

it.for([0, 3])('forwards the exit status %i of vp', async (exitStatus) => {
  const sandbox = createSandbox();
  await installFakeVp(sandbox, exitStatus);

  const run = runTestProjects(pathWith([sandbox.binDirectory, nodeDirectory]));

  expect(run.status).toBe(exitStatus);
});

it('exits 1 with a message when vp is missing from PATH', async () => {
  const sandbox = createSandbox();
  const emptyDirectory = join(sandbox.root, 'empty');
  await mkdir(emptyDirectory);

  const run = runTestProjects(pathWith([emptyDirectory]));

  expect(run.status).toBe(1);
  expect(run.stderr).toContain('Could not run the test projects');
});
