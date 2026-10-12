import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { defaultLockPath } from './queue.js';
import { createFullCheckTool } from './tool.js';

const recorderSource = `
const { appendFileSync } = require('node:fs');
const [record, name] = process.argv.slice(2);
appendFileSync(record, 'start ' + name + '\\n');
setTimeout(() => {
  appendFileSync(record, 'end ' + name + '\\n');
}, 300);
`;

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-full-check-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const agentDirectory = join(directory, 'agent');
  const record = join(directory, 'record.txt');
  const script = join(directory, 'recorder.cjs');

  await mkdir(agentDirectory);
  await writeFile(script, recorderSource);

  return { agentDirectory, record, script };
};

const repositoryNamed = async (name: string) => {
  const root = await createTemporaryRepository(onTestFinished, `tau-full-check-${name}-`);

  await promisify(execFile)(
    'git',
    ['remote', 'add', 'origin', `git@github.com:owner/${name}.git`],
    {
      cwd: root,
    },
  );

  return root;
};

const configure = async (
  agentDirectory: string,
  repositories: Record<string, { argv: string[] }>,
) => {
  await writeFile(
    join(agentDirectory, 'tau.json'),
    JSON.stringify({ fullCheck: { repositories } }),
  );
};

const contextFor = (cwd: string) =>
  ({ cwd, isProjectTrusted: () => true, ui: { notify: () => undefined } }) as never;

const runTool = async (agentDirectory: string, cwd: string) => {
  const updates: string[] = [];

  const result = await createFullCheckTool({ agentDirectory, pollMilliseconds: 10 }).execute(
    'call',
    {},
    undefined,
    (update) => {
      const [block] = update.content;
      updates.push(block?.type === 'text' ? block.text : '');
    },
    contextFor(cwd),
  );

  return { result, updates };
};

it('runs full checks from two repositories one after the other and reports the wait', async () => {
  const { agentDirectory, record, script } = await fixture();
  const first = await repositoryNamed('first');
  const second = await repositoryNamed('second');

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, script, record, 'first'] },
    'owner/second': { argv: [process.execPath, script, record, 'second'] },
  });

  const [firstRun, secondRun] = await Promise.all([
    runTool(agentDirectory, first),
    runTool(agentDirectory, second),
  ]);

  const lines = (await readFile(record, 'utf8')).trim().split('\n');
  const [starter = ''] = lines;
  const name = starter.replace('start ', '');
  const other = name === 'first' ? 'second' : 'first';

  expect(lines).toEqual([`start ${name}`, `end ${name}`, `start ${other}`, `end ${other}`]);

  const waiter = name === 'first' ? secondRun : firstRun;
  const runner = name === 'first' ? firstRun : secondRun;

  expect(runner.updates).toEqual([]);
  expect(waiter.updates).toHaveLength(1);
  expect(waiter.updates[0]).toContain('Waiting');
  expect(waiter.updates[0]).toContain(name === 'first' ? first : second);
  expect(waiter.result.details?.passed).toBe(true);
  await expect(access(defaultLockPath(agentDirectory))).rejects.toThrow('ENOENT');
});

it('takes over a lock left by a dead process', async () => {
  const { agentDirectory, record, script } = await fixture();
  const root = await repositoryNamed('first');

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, script, record, 'first'] },
  });

  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid ?? 0;

  await new Promise((resolve) => {
    child.once('close', resolve);
  });

  const lockPath = defaultLockPath(agentDirectory);

  await mkdir(join(agentDirectory, 'tau'));

  await writeFile(
    lockPath,
    JSON.stringify({
      pid: deadPid,
      checkout: '/gone',
      startedAt: new Date().toISOString(),
      token: 'dead',
    }),
  );

  const { result, updates } = await runTool(agentDirectory, root);

  expect(result.details?.passed).toBe(true);
  expect(updates).toEqual([]);
  expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual(['start first', 'end first']);
});

it('refuses a repository with no entry and runs no command', async () => {
  const { agentDirectory, record, script } = await fixture();
  const root = await repositoryNamed('first');

  await configure(agentDirectory, {
    'owner/other': { argv: [process.execPath, script, record, 'other'] },
  });

  await expect(runTool(agentDirectory, root)).rejects.toThrow('Run your check as before');
  await expect(access(record)).rejects.toThrow('ENOENT');
  await expect(access(defaultLockPath(agentDirectory))).rejects.toThrow('ENOENT');
});

it('reports a failing check as a result with its log', async () => {
  const { agentDirectory } = await fixture();
  const root = await repositoryNamed('first');

  await configure(agentDirectory, {
    'owner/first': { argv: [process.execPath, '-e', 'console.log("boom"); process.exit(3)'] },
  });

  const { result } = await runTool(agentDirectory, root);

  expect(result.details).toMatchObject({ passed: false, exitCode: 3 });
  const logPath = result.details?.logPath ?? '';

  expect(logPath.startsWith(join(root, '.tau', 'checks'))).toBe(true);
  expect(await readFile(logPath, 'utf8')).toBe('boom\n');
  expect(result.details?.tail).toBe('boom');
});
