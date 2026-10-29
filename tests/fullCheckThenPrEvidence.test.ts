import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { listSavedLogs } from '../src/checkRecord/checkRecord.js';
import { readCheckState } from '../src/checkRecord/identity.js';
import { createFullCheckTool } from '../src/extensions/fullCheck/tool.js';
import { decideFullCheck } from '../src/extensions/pr/evidenceDecisions.js';
import { declinedExec } from './declinedExecFake.js';
import { createTemporaryRepository, git } from './gitRepository.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const countingArgv = (counter: string, extra = '') => [
  process.execPath,
  '-e',
  `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x'); ${extra}`,
];

const setUp = async (ignoreRepositoryFile: boolean) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-full-check-pr-');

  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-pr-repo-');
  const counter = join(directory, 'count.txt');

  await writeFile(counter, '');
  await writeFile(join(root, 'tracked.txt'), 'one\n');

  if (ignoreRepositoryFile) {
    await writeFile(join(root, '.gitignore'), '.pi/tau.json\n');
  }

  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await git(root, 'remote', 'add', 'origin', 'git@github.com:owner/reuse.git');

  await mkdir(join(root, '.pi'));

  const configure = (argv: string[]) =>
    writeFile(join(root, '.pi', 'tau.json'), JSON.stringify({ fullCheck: { argv } }));

  const run = () =>
    createFullCheckTool({
      agentDirectory: directory,
      pollMilliseconds: 10,
      exec: declinedExec,
    }).execute('call', {}, undefined, undefined, {
      cwd: root,
      isProjectTrusted: () => true,
      ui: { notify: () => undefined },
    } as never);

  const runCount = async () => (await readFile(counter, 'utf8')).length;

  return { root, counter, configure, run, runCount };
};

it('reports passed to the pr evidence after a changed repository file fails and the first file reuses its log', async () => {
  const { root, counter, configure, run, runCount } = await setUp(false);

  await configure(countingArgv(counter));
  await run();
  await configure(countingArgv(counter, 'process.exit(1)'));
  await run();
  await configure(countingArgv(counter));

  const third = await run();

  expect(third.details).toMatchObject({ passed: true, reused: true });
  expect(await runCount()).toBe(2);

  const state = await readCheckState(root);

  const decision = decideFullCheck(
    state,
    countingArgv(counter),
    await listSavedLogs(join(root, '.tau', 'checks')),
  );

  expect(decision).toMatchObject({ status: 'passed', logPath: third.details?.logPath });
});

it('reruns and reports passed to the pr evidence after a newer failed record of another command on the same tree', async () => {
  const { root, counter, configure, run, runCount } = await setUp(true);

  await configure(countingArgv(counter));
  await run();

  const treeBefore = await readCheckState(root);

  await configure(countingArgv(counter, 'process.exit(1)'));
  const failed = await run();

  await configure(countingArgv(counter));
  const third = await run();

  expect(failed.details).toMatchObject({ passed: false });
  expect(await readCheckState(root)).toEqual(treeBefore);
  expect(third.details).toMatchObject({ passed: true, reused: false });
  expect(await runCount()).toBe(3);

  const state = await readCheckState(root);

  const decision = decideFullCheck(
    state,
    countingArgv(counter),
    await listSavedLogs(join(root, '.tau', 'checks')),
  );

  expect(decision).toMatchObject({ status: 'passed', logPath: third.details?.logPath });
});
