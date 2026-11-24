import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import {
  fakeStartProcessId,
  takeStartTicket,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { architectLockPath, holdArchitectLock } from '../lock.js';
import { acquireStartFence } from './startFence.js';

const startDirectory = (root: string): string => join(root, '.tau', 'architect', 'start');

const latestLockPath = async (root: string): Promise<string> => {
  const directory = dirname(architectLockPath(root));

  const generations = (await readdir(directory))
    .map((name) => /^lock\.(\d+)$/u.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));

  const generation = generations.toSorted((left, right) => left - right).at(-1);

  if (generation === undefined) {
    throw new Error('The lock has no generation.');
  }

  return `${architectLockPath(root)}.${generation}`;
};

const renameLockHolder = async (root: string, processId: number): Promise<void> => {
  const path = await latestLockPath(root);
  const owner = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

  await writeFile(path, JSON.stringify({ ...owner, pid: processId }));
};

const adoptTakenTicket = async (root: string): Promise<void> => {
  const directory = startDirectory(root);
  const names = await readdir(directory);
  const started = names.find((name) => name.includes('.started.'));

  if (started === undefined) {
    throw new Error('The child did not take the ticket.');
  }

  await rename(
    join(directory, started),
    join(directory, started.replace('.started.', '.adopted.')),
  );
};

it('keeps the adopted child after the adopter releases its lock and never signals it', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const acquisition = await acquireStartFence(root);

  if (acquisition.kind !== 'acquired') {
    throw new Error('The start fence was not acquired.');
  }

  const { fence } = acquisition;

  await fence.createTicket();

  expect(await takeStartTicket(fence.wrapArgv(['true']))).toBe(true);

  const adopted = await holdArchitectLock(root, fence.token);

  await adoptTakenTicket(root);
  await adopted.release();

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await fence.abandon()).toEqual({ adopted: true });
  expect(await fence.abandon()).toEqual({ adopted: true });

  const finished = await fence.finish({ adopted: true, stopAttempted: true });

  expect(finished).toEqual({ kept: false });
  expect(processControl.signals).toEqual([]);
});

it('counts a lock holder with the child process id as adopted when its rename failed', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const acquisition = await acquireStartFence(root);

  if (acquisition.kind !== 'acquired') {
    throw new Error('The start fence was not acquired.');
  }

  const { fence } = acquisition;

  await fence.createTicket();

  expect(await takeStartTicket(fence.wrapArgv(['true']))).toBe(true);

  await fence.recordStarted();

  const holder = await holdArchitectLock(root, fence.token);

  expect(await fence.childAdopted()).toBe(false);

  await renameLockHolder(root, fakeStartProcessId);

  expect(await fence.childAdopted()).toBe(true);

  const finished = await fence.finish({ adopted: false, stopAttempted: false });

  await holder.release();

  expect(finished).toEqual({ kept: false });
  expect(processControl.signals).toEqual([]);
});
