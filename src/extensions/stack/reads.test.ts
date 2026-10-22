import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { withoutField } from '../../../tests/withoutField.js';
import type { Repository } from '../../github/github.js';
import { createStackFake } from './fixtures/stackFake.js';
import { readBasedOnPulls, readHeadPulls, readStackViewFacts, runGitRead } from './reads.js';

const unexpected: unknown = expect.stringContaining('unexpected output');

const repository: Repository = { host: 'github.com', owner: 'sQVe', name: 'tau' };

const runtimeFor = (key: 'pr list --head' | 'pr list --base' | 'stack view', stdout: string) => {
  const fake = createStackFake();

  if (key === 'stack view') {
    fake.stackView = { code: 0, stdout, stderr: '' };
  } else {
    fake.overrideOutput(key, stdout);
  }

  return { exec: fake.exec, cwd: process.cwd(), signal: undefined };
};

const headEntry = {
  number: 5,
  url: 'https://github.com/sQVe/tau/pull/5',
  baseRefName: 'main',
  headRepositoryOwner: { login: 'sQVe' },
  headRepository: { name: 'tau' },
};

const missingHeadFields = Object.keys(headEntry).map((key) => ({
  name: `no ${key}`,
  entry: withoutField(headEntry, key),
}));

const malformedHeadEntries = [
  ...missingHeadFields,
  { name: 'a fractional number', entry: { ...headEntry, number: 1.5 } },
  { name: 'an owner without a login', entry: { ...headEntry, headRepositoryOwner: {} } },
  { name: 'a repository without a name', entry: { ...headEntry, headRepository: {} } },
];

it('reads a well-formed head pull request list', async () => {
  const read = await readHeadPulls(
    runtimeFor('pr list --head', JSON.stringify([headEntry])),
    repository,
    'feature',
  );

  expect(read).toEqual({ ok: true, value: [headEntry] });
});

it.each(malformedHeadEntries)('fails a head list entry with $name', async ({ entry }) => {
  const runtime = runtimeFor('pr list --head', JSON.stringify([entry]));

  expect(await readHeadPulls(runtime, repository, 'feature')).toMatchObject({
    ok: false,
    problem: unexpected,
  });
});

const basedEntry = { number: 6, url: 'https://github.com/sQVe/tau/pull/6', headRefName: 'upper' };

const missingBasedFields = Object.keys(basedEntry).map((key) => ({
  name: `no ${key}`,
  entry: withoutField(basedEntry, key),
}));

const malformedBasedEntries = [
  ...missingBasedFields,
  { name: 'a fractional number', entry: { ...basedEntry, number: 1.5 } },
];

it('reads a well-formed based-on pull request list', async () => {
  const runtime = runtimeFor('pr list --base', JSON.stringify([basedEntry]));

  expect(await readBasedOnPulls(runtime, repository, 'feature')).toEqual({
    ok: true,
    value: [basedEntry],
  });
});

it.each(malformedBasedEntries)('fails a based-on list entry with $name', async ({ entry }) => {
  const runtime = runtimeFor('pr list --base', JSON.stringify([entry]));

  expect(await readBasedOnPulls(runtime, repository, 'feature')).toMatchObject({
    ok: false,
    problem: unexpected,
  });
});

const viewLayer = {
  name: 'feature',
  base: 'b'.repeat(40),
  isCurrent: true,
  isMerged: false,
  isQueued: false,
  needsRebase: false,
  pr: null,
};

const viewOf = (branches: unknown) => ({ trunk: 'main', currentBranch: 'feature', branches });

const missingLayerFields = Object.keys(viewLayer)
  .filter((key) => key !== 'pr')
  .map((key) => ({
    name: `a branch with no ${key}`,
    view: viewOf([withoutField(viewLayer, key)]),
  }));

const pullWith = (pr: Record<string, unknown>) => viewOf([{ ...viewLayer, pr }]);

const malformedViews = [
  { name: 'no trunk', view: withoutField(viewOf([viewLayer]), 'trunk') },
  { name: 'no current branch', view: withoutField(viewOf([viewLayer]), 'currentBranch') },
  { name: 'no branches', view: withoutField(viewOf([viewLayer]), 'branches') },
  { name: 'branches that is not a list', view: viewOf(1) },
  ...missingLayerFields,
  { name: 'a pull request with no state', view: pullWith({ number: 1, url: 'u' }) },
  { name: 'a pull request with no number', view: pullWith({ url: 'u', state: 'OPEN' }) },
  { name: 'a pull request with no url', view: pullWith({ number: 1, state: 'OPEN' }) },
];

it('reads a well-formed stack view', async () => {
  const runtime = runtimeFor('stack view', JSON.stringify(viewOf([viewLayer])));

  expect(await readStackViewFacts(runtime)).toMatchObject({ exitCode: 0, view: { ok: true } });
});

it.each(malformedViews)('fails gh stack view output with $name', async ({ view }) => {
  const read = await readStackViewFacts(runtimeFor('stack view', JSON.stringify(view)));

  expect(read).toMatchObject({
    exitCode: 0,
    view: { ok: false, problem: unexpected },
  });
});

it('reads a failed Git process as an output without an exit code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-git-read-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const output = await runGitRead(join(directory, 'missing'), ['status']);

  expect(output.exitCode).toBeNull();
  expect(output.stdout).toBe('');
  expect(output.stderr).not.toBe('');
});
