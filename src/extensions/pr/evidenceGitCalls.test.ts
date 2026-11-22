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

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const sharedRootCommand = 'rev-parse --path-format=absolute --git-common-dir';

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

it('resolves the shared repository root once in one read', async () => {
  const { directory, run } = await createEvidenceRepository(onTestFinished);
  const logPath = join(temporaryDirectory(onTestFinished, 'tau-evidence-git-calls-'), 'calls.log');

  await writeFile(logPath, '');

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [logCommandCalls(logPath)],
  });

  await run({ review: directory });

  const calls = await readCalls(logPath);

  expect(countCalls(calls, sharedRootCommand)).toBe(1);
});

it('gives the gate and verification reads each their own gap when the shared root fails', async () => {
  const { directory, run } = await createEvidenceRepository(onTestFinished);

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [
      { match: sharedRootCommand, script: "printf 'forced shared root failure\\n' >&2\nexit 2" },
    ],
  });

  const evidence = await run({ review: directory });

  expect(evidence.gateDecisions).toBeNull();
  expect(evidence.verification).toBeNull();
  expect(evidence.gaps.filter((gap) => gap.kind === 'gateDecision')).toHaveLength(1);
  expect(evidence.gaps.filter((gap) => gap.kind === 'verification')).toHaveLength(1);
});

it('retries the shared root after a failed read so verification still reads', async () => {
  const { directory, run } = await createEvidenceRepository(onTestFinished);
  const marker = join(temporaryDirectory(onTestFinished, 'tau-shared-root-retry-'), 'failed-once');

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [
      {
        match: sharedRootCommand,
        script: `if [ ! -e ${shellQuote(marker)} ]; then : > ${shellQuote(marker)}; printf 'forced shared root failure\\n' >&2; exit 2; fi\nexec "$real" "$@"`,
      },
    ],
  });

  const evidence = await run({ review: directory });

  expect(evidence.gaps).toContainEqual({
    kind: 'gateDecision',
    reason: expect.stringContaining('forced shared root failure') as unknown,
  });

  expect(evidence.verification).toEqual([]);
  expect(evidence.gaps.filter((gap) => gap.kind === 'verification')).toEqual([]);
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
