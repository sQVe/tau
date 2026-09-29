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
    files: { user: { compaction: { thresholdTokens: 150_000 } } },
    threshold: 150_000,
  },
  {
    name: 'lets the repository file override the user file',
    files: {
      user: { compaction: { thresholdTokens: 150_000 } },
      project: { compaction: { thresholdTokens: 120_000 } },
    },
    threshold: 120_000,
  },
])('$name', ({ files, threshold }) => {
  expect(loadCompactionConfig(setup(files))).toEqual({ thresholdTokens: threshold });
});

it('ignores the repository file in an untrusted project', () => {
  const location = setup(
    {
      user: { compaction: { thresholdTokens: 150_000 } },
      project: { compaction: { thresholdTokens: 120_000 } },
    },
    false,
  );

  expect(loadCompactionConfig(location)).toEqual({ thresholdTokens: 150_000 });
});

it.each([
  { compaction: { thresholdTokens: 0 } },
  { compaction: { thresholdTokens: 39_999 } },
  { compaction: { thresholdTokens: 1.5 } },
  { compaction: { thresholdTokens: '200000' } },
  { compaction: { threshold: 200_000 } },
  { compaction: 200_000 },
])('refuses the invalid value %j and names the file and minimum', (project) => {
  const location = setup({ project });

  expect(() => loadCompactionConfig(location)).toThrow(join(location.cwd, '.pi', 'tau.json'));
  expect(() => loadCompactionConfig(location)).toThrow('40000');
});

it('accepts the minimum threshold', () => {
  const location = setup({ user: { compaction: { thresholdTokens: 40_000 } } });

  expect(loadCompactionConfig(location)).toEqual({ thresholdTokens: 40_000 });
});
