import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { loadCompactionConfig } from './config.js';

const setup = (files: { user?: unknown; project?: unknown }, projectTrusted = true) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-compaction-config-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const agentDirectory = join(directory, 'agent');
  const cwd = join(directory, 'repository');
  mkdirSync(agentDirectory);
  mkdirSync(join(cwd, '.pi'), { recursive: true });

  if (files.user !== undefined) {
    writeFileSync(join(agentDirectory, 'tau.json'), JSON.stringify(files.user));
  }

  if (files.project !== undefined) {
    writeFileSync(join(cwd, '.pi', 'tau.json'), JSON.stringify(files.project));
  }

  return { cwd, agentDirectory, projectTrusted };
};

it.each([
  { name: 'uses the default without config files', files: {}, threshold: 200_000 },
  {
    name: 'uses the default when the files leave compaction unset',
    files: { user: { tdd: {} }, project: { compaction: {} } },
    threshold: 200_000,
  },
  {
    name: 'reads the user file',
    files: { user: { compaction: { reminderTokens: 150_000 } } },
    threshold: 150_000,
  },
  {
    name: 'lets the repository file override the user file',
    files: {
      user: { compaction: { reminderTokens: 150_000 } },
      project: { compaction: { reminderTokens: 120_000 } },
    },
    threshold: 120_000,
  },
])('$name', ({ files, threshold }) => {
  expect(loadCompactionConfig(setup(files))).toEqual({ reminderTokens: threshold });
});

it('ignores the repository file in an untrusted project', () => {
  const location = setup(
    {
      user: { compaction: { reminderTokens: 150_000 } },
      project: { compaction: { reminderTokens: 120_000 } },
    },
    false,
  );

  expect(loadCompactionConfig(location)).toEqual({ reminderTokens: 150_000 });
});

it.each([
  { name: 'a threshold below one token', compaction: { reminderTokens: 0 } },
  { name: 'a fractional threshold', compaction: { reminderTokens: 1.5 } },
  { name: 'a string threshold', compaction: { reminderTokens: '200000' } },
  { name: 'an unknown key', compaction: { thresholdTokens: 200_000 } },
  { name: 'a non-object value', compaction: 200_000 },
])('rejects $name and names the file', ({ compaction }) => {
  const location = setup({ project: { compaction } });

  expect(() => loadCompactionConfig(location)).toThrow(join(location.cwd, '.pi', 'tau.json'));
});
