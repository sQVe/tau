import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createFullCheckTool } from './tool.js';

const git = (cwd: string, ...commandArguments: string[]) =>
  promisify(execFile)(
    'git',
    ['-c', 'user.name=Tau', '-c', 'user.email=tau@example.com', ...commandArguments],
    { cwd },
  );

const countingArgv = (counter: string, extra = '') => [
  process.execPath,
  '-e',
  `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x'); ${extra}`,
];

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-full-check-reuse-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-reuse-repo-');
  const counter = join(directory, 'count.txt');

  await writeFile(counter, '');
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await git(root, 'remote', 'add', 'origin', 'git@github.com:owner/reuse.git');

  const configure = (argv: string[]) =>
    writeFile(
      join(directory, 'tau.json'),
      JSON.stringify({ fullCheck: { repositories: { 'owner/reuse': { argv } } } }),
    );

  await configure(countingArgv(counter));

  const run = (base?: string) =>
    createFullCheckTool({ agentDirectory: directory, pollMilliseconds: 10 }).execute(
      'call',
      base === undefined ? {} : { base },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true, ui: { notify: () => undefined } } as never,
    );

  const runCount = async () => (await readFile(counter, 'utf8')).length;

  return { root, counter, configure, run, runCount };
};

it('returns the saved passing log for an unchanged state without running the command', async () => {
  const { run, runCount } = await fixture();

  const first = await run();
  const second = await run();

  expect(first.details?.reused).toBe(false);
  expect(second.details).toMatchObject({ passed: true, reused: true });
  expect(second.details?.logPath).toBe(first.details?.logPath);
  expect(await runCount()).toBe(1);
});

it.each([
  {
    change: 'an edit to a tracked file',
    apply: async ({ root }: Awaited<ReturnType<typeof fixture>>) => {
      await writeFile(join(root, 'tracked.txt'), 'two\n');
    },
  },
  {
    change: 'a new untracked file',
    apply: async ({ root }: Awaited<ReturnType<typeof fixture>>) => {
      await writeFile(join(root, 'new.txt'), 'new\n');
    },
  },
  {
    change: 'a changed argv',
    apply: async ({ configure, counter }: Awaited<ReturnType<typeof fixture>>) => {
      await configure(countingArgv(counter, '// changed'));
    },
  },
])('runs the command again after $change', async ({ apply }) => {
  const state = await fixture();

  await state.run();
  await apply(state);
  const second = await state.run();

  expect(second.details).toMatchObject({ passed: true, reused: false });
  expect(await state.runCount()).toBe(2);
});

it('runs the command again for a different base', async () => {
  const state = await fixture();

  await writeFile(join(state.root, 'tracked.txt'), 'two\n');
  await git(state.root, 'commit', '--quiet', '-am', 'second');

  await state.run('HEAD');
  const sameBase = await state.run('HEAD');
  const otherBase = await state.run('HEAD~1');

  expect(sameBase.details?.reused).toBe(true);
  expect(otherBase.details?.reused).toBe(false);
  expect(await state.runCount()).toBe(2);
});

it('rejects a base that names no commit and runs no command', async () => {
  const { run, runCount } = await fixture();

  await expect(run('no-such-ref')).rejects.toThrow('no-such-ref');
  expect(await runCount()).toBe(0);
});

it('saves no reusable record for a failing run', async () => {
  const { configure, counter, run, runCount, root } = await fixture();

  await configure(countingArgv(counter, 'process.exit(1)'));

  const first = await run();
  const second = await run();

  expect(first.details).toMatchObject({ passed: false, reused: false });
  expect(second.details?.reused).toBe(false);
  expect(await runCount()).toBe(2);

  const saved = await readdir(join(root, '.tau', 'checks'));

  expect(saved.filter((name) => name.endsWith('.json'))).toEqual([]);
});

it('saves no reusable record when the inputs change during the run', async () => {
  const { configure, counter, run, runCount, root } = await fixture();

  const edit = `require('node:fs').appendFileSync('tracked.txt', 'more\\n');`;
  await configure(countingArgv(counter, edit));

  const first = await run();
  const second = await run();

  expect(first.details).toMatchObject({ passed: true, reused: false });
  expect(second.details?.reused).toBe(false);
  expect(await runCount()).toBe(2);

  const saved = await readdir(join(root, '.tau', 'checks'));

  expect(saved.filter((name) => name.endsWith('.json'))).toEqual([]);
});

it('returns a passing log saved by another session while this check waited in the queue', async () => {
  const { configure, counter, run, runCount } = await fixture();

  await configure(countingArgv(counter, 'setTimeout(() => {}, 400);'));

  const running = run();

  await vi.waitFor(async () => {
    expect(await runCount()).toBe(1);
  });

  const waiting = await run();
  const started = await running;

  expect(started.details?.reused).toBe(false);
  expect(waiting.details).toMatchObject({ passed: true, reused: true });
  expect(waiting.details?.logPath).toBe(started.details?.logPath);
  expect(await runCount()).toBe(1);
});

it('runs the command again after the executable mode of an untracked file changes', async () => {
  const state = await fixture();
  const script = join(state.root, 'script.sh');

  await writeFile(script, 'echo hi\n', { mode: 0o644 });
  await state.run();
  await chmod(script, 0o755);
  const second = await state.run();

  expect(second.details?.reused).toBe(false);
  expect(await state.runCount()).toBe(2);
});

it('runs the command again after an edit to a file with a lossy textconv driver', async () => {
  const state = await fixture();

  await writeFile(join(state.root, '.gitattributes'), '*.txt diff=lossy\n');
  await git(state.root, 'config', 'diff.lossy.textconv', 'true');
  await git(state.root, 'add', '.');
  await git(state.root, 'commit', '--quiet', '-m', 'driver');

  await state.run();
  await writeFile(join(state.root, 'tracked.txt'), 'two\n');
  const second = await state.run();

  expect(second.details?.reused).toBe(false);
  expect(await state.runCount()).toBe(2);
});

it('runs the command for each different dirty edit inside a submodule', async () => {
  const state = await fixture();
  const source = await createTemporaryRepository(onTestFinished, 'tau-full-check-submodule-');

  await writeFile(join(source, 'inner.txt'), 'one\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '--quiet', '-m', 'inner');
  await git(state.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'inner');
  await git(state.root, 'commit', '--quiet', '-m', 'submodule');

  await writeFile(join(state.root, 'inner', 'inner.txt'), 'edit a\n');
  await state.run();
  await writeFile(join(state.root, 'inner', 'inner.txt'), 'edit b\n');
  const second = await state.run();

  expect(second.details?.reused).toBe(false);
  expect(await state.runCount()).toBe(2);

  await writeFile(join(state.root, 'inner', 'untracked.txt'), 'new\n');
  await state.run();

  expect(await state.runCount()).toBe(3);

  const saved = await readdir(join(state.root, '.tau', 'checks'));

  expect(saved.filter((name) => name.endsWith('.json'))).toEqual([]);
});

it('saves no reusable record when the base ref moves during the run', async () => {
  const { configure, counter, run, runCount, root } = await fixture();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await git(root, 'commit', '--quiet', '-am', 'second');
  await git(root, 'branch', 'moving');

  const move = `require('node:child_process').execFileSync('git', ['update-ref', 'refs/heads/moving', 'HEAD~1']);`;
  await configure(countingArgv(counter, move));

  const first = await run('moving');

  expect(first.details).toMatchObject({ passed: true, reused: false });
  expect(await runCount()).toBe(1);

  const saved = await readdir(join(root, '.tau', 'checks'));

  expect(saved.filter((name) => name.endsWith('.json'))).toEqual([]);
});
