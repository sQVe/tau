import { readFileSync } from 'node:fs';
import { mkdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { saveCheckRecord } from '../../../checkRecord/checkRecord.js';
import { readCheckIdentity } from '../../../checkRecord/identity.js';
import {
  inventoryNotRegularMessage,
  inventoryTooLargeMessage,
  inventoryUnreadableMessage,
} from './pageInventory/pageInventoryRefusal.js';
import { checkReport } from './reportChecks.js';
import type { ReportCheckFacts } from './reportChecks.js';

const readFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
  error: undefined as Error | undefined,
}));

const inventorySwap = vi.hoisted(() => ({
  path: undefined as string | undefined,
  original: undefined as string | undefined,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    open: async (...parameters: Parameters<typeof actual.open>) => {
      const target = parameters[0];
      const failure = readFailure;
      const error = failure.error;

      if (typeof target === 'string' && failure.path === target && error !== undefined) {
        return {
          stat: async () => ({ isFile: () => true, size: 0 }),
          readFile: async () => {
            throw error;
          },
          close: async () => undefined,
        } as unknown as Awaited<ReturnType<typeof actual.open>>;
      }

      const handle = await actual.open(...parameters);

      if (
        typeof target !== 'string' ||
        inventorySwap.path !== target ||
        inventorySwap.original === undefined
      ) {
        return handle;
      }

      const original = inventorySwap.original;
      const originalStat = handle.stat.bind(handle);

      Object.defineProperty(handle, 'stat', {
        value: async () => {
          const file = await originalStat();

          inventorySwap.original = undefined;
          await actual.rename(target, original);
          await actual.mkdir(target);

          return file;
        },
      });

      return handle;
    },
  };
});

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
  profile: 'worker',
  task: 'Do the thing.',
  assignmentDirectory: root,
  root,
  argv,
  fullCheck: null,
  summary: 'Done.\n\nChanges: None\nEvidence: None\nDecisions: None\nConcerns: None',
  evidence: [],
  ...overrides,
});

const declaredFullCheck = { owner: 'AI-1688', reason: 'the module is not wired in yet' };

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

const qaFacts = (directory: string, overrides: Partial<ReportCheckFacts> = {}): ReportCheckFacts =>
  facts(directory, {
    role: 'investigation',
    profile: 'qa',
    task: 'Check the team overview.\n\nApp URL: http://localhost:3000',
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

it('refuses a declared report when no record exists', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');

  expect(await checkReport(facts(root, { fullCheck: declaredFullCheck }))).toEqual({
    status: 'refuse',
    message:
      'Report refused: no full check record for the current tree and command. Run full_check on the final tree, then report.',
  });
});

it('refuses a declared report when the record file is malformed', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');

  const directory = join(root, '.tau/checks');

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'run.json'), 'not a record');
  await writeFile(join(directory, 'run.log'), 'output');

  expect(await checkReport(facts(root, { fullCheck: declaredFullCheck }))).toEqual({
    status: 'refuse',
    message:
      'Report refused: no full check record for the current tree and command. Run full_check on the final tree, then report.',
  });
});

it('refuses a declared report when the newest record log file was deleted', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');

  const logPath = await saveCheck(root, true);

  await unlink(logPath);

  expect(
    await checkReport(
      facts(root, { fullCheck: declaredFullCheck, evidence: [`check log: ${logPath}`] }),
    ),
  ).toEqual({
    status: 'refuse',
    message:
      'Report refused: the newest full check record for the current tree and command has no log. Run full_check again on the final tree, then report.',
  });
});

it('accepts an inventory that names the contradicting page title in Decisions', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const inventoryPath = join(root, 'page-inventory.md');

  await writeFile(join(root, '.gitignore'), '.tau/\n');
  await writeFile(inventoryPath, fixture('account-settings-inventory.md'));

  expect(
    await checkReport(
      qaFacts(root, {
        summary: fixture('account-settings-summary.md'),
        evidence: [inventoryPath],
      }),
    ),
  ).toEqual({ status: 'accept', fullCheck: null });
});

it('reads no inventory when the task has no app URL line', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');
  await mkdir(join(root, 'page-inventory.md'));

  expect(await checkReport(qaFacts(root, { task: 'Check the team overview.' }))).toEqual({
    status: 'accept',
    fullCheck: null,
  });
});

it('reads no inventory when the profile is not qa', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');
  await mkdir(join(root, 'page-inventory.md'));

  expect(
    await checkReport(
      facts(root, {
        role: 'investigation',
        profile: 'worker',
        task: 'Check the team overview.\n\nApp URL: http://localhost:3000',
      }),
    ),
  ).toEqual({ status: 'accept', fullCheck: null });
});

it('refuses an inventory path that is not a regular file', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const inventoryPath = join(root, 'page-inventory.md');

  await writeFile(join(root, '.gitignore'), '.tau/\n');
  await mkdir(inventoryPath);

  expect(await checkReport(qaFacts(root))).toEqual({
    status: 'refuse',
    message: inventoryNotRegularMessage(inventoryPath),
  });
});

it('refuses a symlink to a device as not regular without reading it', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const inventoryPath = join(root, 'page-inventory.md');

  await writeFile(join(root, '.gitignore'), '.tau/\n');
  await symlink('/dev/zero', inventoryPath);

  expect(await checkReport(qaFacts(root))).toEqual({
    status: 'refuse',
    message: inventoryNotRegularMessage(inventoryPath),
  });
});

it('refuses an inventory larger than the size limit without reading it', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const inventoryPath = join(root, 'page-inventory.md');

  await writeFile(join(root, '.gitignore'), '.tau/\n');
  await writeFile(inventoryPath, 'x'.repeat(1_048_577));

  expect(await checkReport(qaFacts(root))).toEqual({
    status: 'refuse',
    message: inventoryTooLargeMessage(inventoryPath),
  });
});

it('reads the inventory through the handle it checked', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const inventoryPath = join(root, 'page-inventory.md');
  const originalPath = join(root, 'original-inventory.md');

  await writeFile(join(root, '.gitignore'), '.tau/\n');
  await writeFile(inventoryPath, fixture('account-settings-inventory.md'));

  inventorySwap.path = inventoryPath;
  inventorySwap.original = originalPath;

  onTestFinished(() => {
    inventorySwap.path = undefined;
    inventorySwap.original = undefined;
  });

  expect(
    await checkReport(
      qaFacts(root, {
        summary: fixture('account-settings-summary.md'),
        evidence: [inventoryPath],
      }),
    ),
  ).toEqual({ status: 'accept', fullCheck: null });

  expect((await stat(inventoryPath)).isDirectory()).toBe(true);
});

it('refuses a symlink-loop inventory as unreadable', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');
  await symlink('page-inventory.md', join(root, 'page-inventory.md'));

  expect(await checkReport(qaFacts(root))).toEqual({
    status: 'refuse',
    message: inventoryUnreadableMessage(join(root, 'page-inventory.md')),
  });
});

it('refuses an inventory read failure with EPERM as unreadable', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const inventoryPath = join(root, 'page-inventory.md');
  const error = Object.assign(new Error('permission denied'), { code: 'EPERM' });

  await writeFile(inventoryPath, '');

  onTestFinished(() => {
    readFailure.path = undefined;
    readFailure.error = undefined;
  });

  readFailure.path = inventoryPath;
  readFailure.error = error;

  expect(await checkReport(qaFacts(root))).toEqual({
    status: 'refuse',
    message: inventoryUnreadableMessage(inventoryPath),
  });
});

it('propagates an unexpected inventory read failure', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const inventoryPath = join(root, 'page-inventory.md');
  const error = Object.assign(new Error('read failed'), { code: 'EIO' });

  await writeFile(inventoryPath, '');

  onTestFinished(() => {
    readFailure.path = undefined;
    readFailure.error = undefined;
  });

  readFailure.path = inventoryPath;
  readFailure.error = error;

  await expect(checkReport(qaFacts(root))).rejects.toBe(error);
});
