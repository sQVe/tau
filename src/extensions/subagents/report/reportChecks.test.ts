import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { saveCheckRecord } from '../../../checkRecord/checkRecord.js';
import { readCheckIdentity } from '../../../checkRecord/identity.js';
import { checkReport } from './reportChecks.js';
import type { ReportCheckFacts } from './reportChecks.js';

const argv = ['pnpm', 'check'];

const saveCheck = async (root: string, passed: boolean): Promise<string> => {
  const identity = await readCheckIdentity(root, argv);
  const directory = join(root, '.tau/checks');
  const logPath = join(directory, 'run.log');

  await mkdir(directory, { recursive: true });
  await writeFile(logPath, 'output');
  await saveCheckRecord(logPath, identity, passed);

  return logPath;
};

const facts = (root: string, overrides: Partial<ReportCheckFacts> = {}): ReportCheckFacts => ({
  role: 'editing',
  root,
  argv,
  fullCheck: null,
  summary: 'Done.\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None',
  evidence: [],
  ...overrides,
});

it('reads a passing record for the current tree and command', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');
  await saveCheck(root, true);

  expect(await checkReport(facts(root))).toEqual({ status: 'accept', fullCheck: null });
});

it('returns the cited declared record identity and result', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');

  const logPath = await saveCheck(root, false);

  expect(
    await checkReport(
      facts(root, {
        fullCheck: { owner: 'AI-1688', reason: 'the module is not wired in yet' },
        evidence: [`check log: ${logPath}`],
      }),
    ),
  ).toEqual({
    status: 'accept',
    fullCheck: { owner: 'AI-1688', logPath, passed: false },
  });
});
