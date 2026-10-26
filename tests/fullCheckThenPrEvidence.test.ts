import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { listSavedLogs } from '../src/checkRecord/checkRecord.js';
import { readCheckState } from '../src/checkRecord/identity.js';
import { createFullCheckTool } from '../src/extensions/fullCheck/tool.js';
import { decideFullCheck } from '../src/extensions/pr/evidenceDecisions.js';
import { declinedExec } from './declinedExecFake.js';
import { createTemporaryRepository } from './gitRepository.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

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

it('reports passed to the pr evidence after the first command runs again over another command that failed', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-full-check-pr-');

  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-pr-repo-');
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

  await configure(countingArgv(counter));
  await run();
  await configure(countingArgv(counter, 'process.exit(1)'));
  await run();
  await configure(countingArgv(counter));

  const third = await run();

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
