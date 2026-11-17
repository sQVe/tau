import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { saveCheckRecord } from '../../checkRecord/checkRecord.js';
import { readCheckIdentity } from '../../checkRecord/identity.js';
import { checkRefusal } from './reportChecks.js';

const argv = ['pnpm', 'check'];

const saveCheck = async (
  root: string,
  commandArguments: string[],
  passed: boolean,
): Promise<void> => {
  const identity = await readCheckIdentity(root, commandArguments);
  const directory = join(root, '.tau/checks');
  const logPath = join(directory, 'run.log');

  await mkdir(directory, { recursive: true });
  await writeFile(logPath, 'output');
  await saveCheckRecord(logPath, identity, passed);
};

it.each([
  {
    name: 'an editing success needs a passing record',
    role: 'editing' as const,
    record: 'passing' as const,
    commandArguments: argv,
    expected: undefined,
  },
  {
    name: 'a failing record refuses',
    role: 'editing' as const,
    record: 'failing' as const,
    commandArguments: argv,
    expected:
      'Report refused: no passing full check record for the current tree. Run full_check on the final tree, then report.',
  },
  {
    name: 'a configured full check with no record refuses',
    role: 'editing' as const,
    record: 'none' as const,
    commandArguments: argv,
    expected:
      'Report refused: no passing full check record for the current tree. Run full_check on the final tree, then report.',
  },
  {
    name: 'an investigation role passes',
    role: 'investigation' as const,
    record: 'none' as const,
    commandArguments: argv,
    expected: undefined,
  },
  {
    name: 'no configured full check accepts the report',
    role: 'editing' as const,
    record: 'none' as const,
    commandArguments: undefined,
    expected: undefined,
  },
])('$name', async ({ role, record, commandArguments, expected }) => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');

  if (record !== 'none') {
    await saveCheck(root, argv, record === 'passing');
  }

  expect(await checkRefusal({ role, root, argv: commandArguments })).toBe(expected);
});
