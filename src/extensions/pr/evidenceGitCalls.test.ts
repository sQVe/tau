import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { installCommandShim, logCommandCalls } from '../../../tests/commandShimFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { createEvidenceRepository } from './fixtures/evidenceRepository.js';

const readCalls = async (logPath: string): Promise<string[]> => {
  const text = await readFile(logPath, 'utf8');

  return text.split('\n').filter((line) => line !== '');
};

const countCalls = (calls: string[], command: string): number =>
  calls.filter((call) => call === command).length;

it('asks Git for the object format, bare state, and check state at most once in one read', async () => {
  const { directory, run } = await createEvidenceRepository(onTestFinished);
  const logPath = join(temporaryDirectory(onTestFinished, 'tau-evidence-git-calls-'), 'calls.log');

  await writeFile(logPath, '');

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [logCommandCalls(logPath)],
  });

  await run({ review: directory });

  const calls = await readCalls(logPath);

  expect(countCalls(calls, 'rev-parse --show-object-format')).toBeLessThanOrEqual(1);
  expect(countCalls(calls, 'rev-parse --is-bare-repository')).toBeLessThanOrEqual(1);
  expect(countCalls(calls, 'version')).toBe(1);
});

it('probes the object format and bare state on a cold root', async () => {
  const { root, directory, runIn } = await createEvidenceRepository(onTestFinished);
  const copy = join(temporaryDirectory(onTestFinished, 'tau-evidence-cold-'), 'repository');

  await cp(root, copy, { recursive: true });

  const copiedDirectory = join(copy, relative(root, directory));
  const logPath = join(temporaryDirectory(onTestFinished, 'tau-evidence-git-calls-'), 'calls.log');

  await writeFile(logPath, '');

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [logCommandCalls(logPath)],
  });

  await runIn(copy, { remote: 'origin', review: copiedDirectory });

  const calls = await readCalls(logPath);

  expect(countCalls(calls, 'rev-parse --show-object-format')).toBe(1);
  expect(countCalls(calls, 'rev-parse --is-bare-repository')).toBe(1);
  expect(countCalls(calls, 'version')).toBe(1);
});
