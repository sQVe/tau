import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { readCheckState } from '../src/checkRecord/identity.js';
import { createEvidenceRepository } from '../src/extensions/pr/fixtures/evidenceRepository.js';
import { createPrTool } from '../src/extensions/pr/tool.js';
import type { LaunchResult } from '../src/extensions/verification/launchAction.js';
import type { StopResult } from '../src/extensions/verification/stopAction.js';
import { createVerificationTool } from '../src/extensions/verification/tool.js';
import workerRecordExtension from '../src/extensions/verification/workerRecord.js';
import { readRunRecord } from '../src/verification/verification.js';
import { fakeExtensionApi } from './extensionApi.js';
import { git } from './gitRepository.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';
import { noUiContext } from './toolContext.js';

const targetCommands = (logPath: string) => ({
  launch: ['sh', '-c', `printf 'launch\\t%s\\n' "$PWD" >> ${JSON.stringify(logPath)}; exit 0`],
  doctor: ['sh', '-c', `printf 'doctor\\t%s\\n' "$PWD" >> ${JSON.stringify(logPath)}; exit 0`],
  stop: ['sh', '-c', `printf 'stop\\t%s\\n' "$PWD" >> ${JSON.stringify(logPath)}; exit 0`],
});

const configFor = (logPath: string) => ({
  fullCheck: { argv: ['pnpm', 'check'] },
  verification: { targets: { app: targetCommands(logPath) } },
});

const contextFor = (cwd: string) => ({ ...noUiContext(cwd), isProjectTrusted: () => true });

it('lists a worktree run as fresh from the main checkout before and after the worktree is removed', async () => {
  const { root, directory: review, fake } = await createEvidenceRepository(onTestFinished);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-verification-pr-agent-');
  const logs = temporaryDirectory(onTestFinished, 'tau-verification-pr-logs-');
  const mainLog = join(logs, 'main.txt');
  const worktreeLog = join(logs, 'worktree.txt');

  await writeFile(join(root, '.pi', 'tau.json'), JSON.stringify(configFor(mainLog)));
  await writeFile(join(root, 'tracked.txt'), 'main\n');
  await git(root, 'add', '.pi/tau.json', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'configure the app target');

  const worktree = join(
    temporaryDirectory(onTestFinished, 'tau-verification-pr-worktree-'),
    'launching',
  );

  await git(root, 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
  await writeFile(join(worktree, '.pi', 'tau.json'), JSON.stringify(configFor(worktreeLog)));
  await writeFile(join(worktree, 'tracked.txt'), 'worktree\n');
  await git(worktree, 'add', '.pi/tau.json', 'tracked.txt');
  await git(worktree, 'commit', '--quiet', '-m', 'use the worktree commands');

  const worktreeCommit = await git(worktree, 'rev-parse', 'HEAD');
  const item = 'journeys/check';
  const verification = createVerificationTool({ agentDirectory });

  const launched = await verification.execute(
    'call',
    { action: 'launch', target: 'app' },
    undefined,
    undefined,
    contextFor(worktree),
  );

  const launch = launched.details as LaunchResult;

  expect(launch.status).toBe('ready');

  if (launch.status !== 'ready') {
    return;
  }

  expect(launch.directory).toBe(join(root, '.tau', 'verification', launch.run));

  await verification.execute(
    'call',
    { action: 'register', run: launch.run, items: [{ item, steps: 1 }] },
    undefined,
    undefined,
    contextFor(worktree),
  );

  const api = fakeExtensionApi();

  workerRecordExtension(api.pi);

  const recordTool = api.tools.get('verification_record');

  if (recordTool === undefined) {
    throw new Error('The verification record tool is not registered.');
  }

  await recordTool.execute(
    'call',
    {
      run: launch.run,
      item,
      steps: [{ status: 'passed', artifacts: [] }],
      endState: { status: 'passed' },
    },
    undefined,
    undefined,
    contextFor(worktree),
  );

  const stopped = await verification.execute(
    'call',
    { action: 'stop', run: launch.run },
    undefined,
    undefined,
    contextFor(worktree),
  );

  const stop = stopped.details as StopResult;

  expect(stop).toMatchObject({ run: launch.run, exitCode: 0, freshness: { fresh: true } });
  expect(existsSync(mainLog)).toBe(false);

  const commandLines = (await readFile(worktreeLog, 'utf8')).trim().split('\n');

  expect(commandLines.map((line) => line.split('\t')[0])).toEqual(['launch', 'doctor', 'stop']);

  for (const line of commandLines) {
    const [, cwd] = line.split('\t');

    expect(await realpath(cwd ?? '')).toBe(await realpath(worktree));
  }

  const recordRead = await readRunRecord(
    join(root, '.tau', 'verification', launch.run, 'run.json'),
  );

  expect(recordRead.status).toBe('valid');

  if (recordRead.status !== 'valid') {
    return;
  }

  const worktreeTree = (await readCheckState(worktree)).tree;
  const mainTree = (await readCheckState(root)).tree;

  expect(worktreeTree).not.toBeNull();
  expect(worktreeTree).not.toBe(mainTree);
  expect(recordRead.record.treeAtLaunch).toBe(worktreeTree);
  expect(recordRead.record.treeAtStop).toBe(worktreeTree);

  expect(await readFile(join(root, 'tracked.txt'), 'utf8')).not.toBe(
    await readFile(join(worktree, 'tracked.txt'), 'utf8'),
  );

  await git(root, 'checkout', '--quiet', '-b', 'reading', worktreeCommit);

  expect((await readCheckState(root)).tree).toBe(worktreeTree);

  const prTool = createPrTool(fake.exec, { agentDirectory });

  const readVerification = async () => {
    const result = await prTool.execute(
      'call',
      { action: 'evidence', review },
      undefined,
      undefined,
      contextFor(root),
    );

    return result.details['verification'];
  };

  const expected = [
    {
      target: 'app',
      item,
      run: launch.run,
      fresh: true,
      result: 'passed',
      counts: { passed: 1, differs: 0, blocked: 0, notRun: 0 },
    },
  ];

  expect(await readVerification()).toEqual(expected);

  await git(root, 'worktree', 'remove', '--force', worktree);

  expect(await readVerification()).toEqual(expected);

  await writeFile(join(root, 'tracked.txt'), 'changed\n');

  expect(await readVerification()).toEqual([
    { ...expected[0], fresh: false, reason: 'treeChangedSinceRun' },
  ]);
});
