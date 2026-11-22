import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readQuestionGateConfig, shadowCohort } from '../src/config/questionGateModels.ts';
import type { ShadowRecord } from '../src/questionGate/questionGate.ts';
import { createTemporaryRepository } from '../tests/gitRepository.ts';
import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.ts';

const script = join(import.meta.dirname, 'questionGateScore.ts');

const gateConfig = {
  questionGate: {
    classifier: 'fixture/classifier',
    panel: ['fixture/panel-a', 'fixture/panel-b', 'fixture/panel-c'],
    shadow: { variant: 'classifier', cutoff: 0.8 },
  },
};

const question: ShadowRecord['question'] = {
  question: 'Which database should the service use?',
  problem: 'The service ships next week.',
  impact: 'Changing the database later moves every stored row.',
  options: [
    { label: 'Postgres', description: 'One primary.', recommended: true },
    { label: 'MySQL', description: 'One primary with another dialect.', recommended: false },
  ],
};

const judges = (milliseconds: number): ShadowRecord['judges'] => ({
  classifier: { verdict: { kind: 'answered', confidence: 0.9 }, milliseconds },
  classifierExamples: { verdict: { kind: 'answered', confidence: 0.9 }, milliseconds },
  panel: { verdict: { kind: 'answered', confidence: 0.9 }, milliseconds },
  panelExamples: { verdict: { kind: 'answered', confidence: 0.9 }, milliseconds },
  agent: { verdict: { kind: 'answered', confidence: 0.9 }, milliseconds: 0 },
});

const recordFor = (sessionId: string, milliseconds: number, cohort: string): ShadowRecord => ({
  version: 1,
  kind: 'shadow',
  cohort,
  sessionId,
  question,
  confidence: 0.9,
  judges: judges(milliseconds),
  answer: { kind: 'answered', selected: ['Postgres'], typed: false },
});

const shadowName = (index: number): string =>
  `shadow-${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000.json`;

const writeConfig = async (agentDirectory: string, value: unknown): Promise<void> => {
  await writeFile(join(agentDirectory, 'tau.json'), JSON.stringify(value));
};

const cohortOf = (repository: string, agentDirectory: string): string => {
  const location = { cwd: repository, agentDirectory, projectTrusted: false };
  const config = readQuestionGateConfig(location, { notify: () => undefined });

  if (config?.shadow === undefined) {
    throw new Error('The fixture config has no shadow setting.');
  }

  return shadowCohort({ ...config, shadow: config.shadow });
};

const writeRecord = async (
  repository: string,
  index: number,
  record: ShadowRecord,
): Promise<void> => {
  const directory = join(repository, '.tau', 'questions');

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, shadowName(index)), JSON.stringify(record));
};

const snapshot = async (directory: string, prefix = ''): Promise<Record<string, string>> => {
  const entries = await readdir(directory, { withFileTypes: true });

  const pairs = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === '.git') {
        return [];
      }

      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return Object.entries(await snapshot(path, name));
      }

      return entry.isFile() ? [[name, await readFile(path, 'utf8')] as const] : [];
    }),
  );

  return Object.fromEntries(pairs.flat());
};

const runShadow = (cwd: string, agentDirectory: string, args: readonly string[] = ['--shadow']) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
  });

it('reports only the frozen shadow cohort', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-shadow-score-');
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');

  await writeConfig(agentDirectory, gateConfig);

  const cohort = cohortOf(repository, agentDirectory);

  await writeRecord(repository, 1, recordFor('session-a', 10, cohort));
  await writeRecord(repository, 2, recordFor('session-b', 30, cohort));
  await writeRecord(repository, 3, recordFor('session-c', 500, 'another-cohort'));
  await writeFile(join(repository, '.tau', 'questions', shadowName(4)), '{"version":1');

  const before = { repository: await snapshot(repository), agent: await snapshot(agentDirectory) };
  const result = runShadow(repository, agentDirectory);
  const after = { repository: await snapshot(repository), agent: await snapshot(agentDirectory) };

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Sampled dialogs: 2');
  expect(result.stdout).toContain('Predictions: 2 from 2 sessions');
  expect(result.stdout).toContain('Agreement: 100.0%');
  expect(result.stdout).toContain('95% lower bound: 13.5%');
  expect(result.stdout).toContain('Potential saves: 2 (100.0% of sampled dialogs)');
  expect(result.stdout).toContain('Actual saves: 0');
  expect(result.stdout).toContain('Judge time: 20.0 ms mean');
  expect(result.stderr).toContain('Excluded 1 shadow records from other cohorts.');
  expect(result.stderr).toContain('Shadow record warning:');
  expect(after).toEqual(before);
});

it('warns about an unknown shadow key and still scores', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-shadow-unknown-');
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');

  await writeConfig(agentDirectory, {
    questionGate: {
      ...gateConfig.questionGate,
      shadow: { ...gateConfig.questionGate.shadow, extra: true },
    },
  });

  const result = runShadow(repository, agentDirectory);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Agreement: n/a');

  const userFile = join(agentDirectory, 'tau.json');
  const warnings = result.stderr.match(/questionGate\.shadow\.extra/gu) ?? [];

  expect(warnings).toHaveLength(1);
  expect(result.stderr).toContain(userFile);
});

it('reports n/a when every shadow record is a gap', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-shadow-gaps-');
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');
  const directory = join(repository, '.tau', 'questions');

  await writeConfig(agentDirectory, gateConfig);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, shadowName(1)), '{"version":1');

  const result = runShadow(repository, agentDirectory);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Agreement: n/a');
  expect(result.stderr).toContain('Shadow record warning:');
});

it('exits 1 when the shadow path is not a directory', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-shadow-not-directory-');
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');

  await writeConfig(agentDirectory, gateConfig);
  await mkdir(join(repository, '.tau'), { recursive: true });
  await writeFile(join(repository, '.tau', 'questions'), 'not a directory');

  const result = runShadow(repository, agentDirectory);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Could not read shadow records');
});

it('refuses a linked shadow directory', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-shadow-symlink-');
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');
  const outside = temporaryDirectory(onTestFinished, 'tau-shadow-outside-');

  await writeConfig(agentDirectory, gateConfig);
  await mkdir(join(repository, '.tau'), { recursive: true });
  await symlink(outside, join(repository, '.tau', 'questions'), 'dir');

  const result = runShadow(repository, agentDirectory);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('symlink');
});

it('reports n/a when the shadow directory is missing', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-shadow-missing-');
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');

  await writeConfig(agentDirectory, gateConfig);

  const result = runShadow(repository, agentDirectory);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Agreement: n/a');
  expect(result.stdout).toContain('95% lower bound: n/a');
  expect(result.stdout).toContain('Potential saves: 0 (n/a of sampled dialogs)');
  expect(result.stdout).toContain('Judge time: n/a mean');
});

it('rejects a historical flag with --shadow', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-shadow-flags-');
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');

  const result = runShadow(repository, agentDirectory, ['--shadow', '--limit', '3']);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--shadow');
  expect(result.stderr).toContain('--limit');
});

it('exits 1 naming the missing shadow setting and user config path', async ({ onTestFinished }) => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-shadow-config-');
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');

  await writeConfig(agentDirectory, {
    questionGate: {
      classifier: gateConfig.questionGate.classifier,
      panel: gateConfig.questionGate.panel,
    },
  });

  const result = runShadow(repository, agentDirectory);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('questionGate.shadow');
  expect(result.stderr).toContain(join(agentDirectory, 'tau.json'));
});

it('exits 1 outside a Git repository', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-shadow-no-root-');
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');

  await writeConfig(agentDirectory, gateConfig);

  const result = runShadow(directory, agentDirectory);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('rev-parse');
});
