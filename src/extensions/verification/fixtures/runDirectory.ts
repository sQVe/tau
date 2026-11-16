import { writeFile } from 'node:fs/promises';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { ensureTauDirectory } from '../../../tauDirectory.js';
import type { RunRecord } from '../../../verification/records.js';
import { runRecordPath } from '../../../verification/verification.js';

export interface RunDirectoryOptions {
  items: RunRecord['items'];
  stop?: RunRecord['stop'];
}

export interface RunDirectory {
  root: string;
  directory: string;
}

const validRunRecord = (run: string, options: RunDirectoryOptions): RunRecord => ({
  version: 1,
  run,
  target: '482',
  head: '1111111111111111111111111111111111111111',
  dirty: false,
  platform: { os: 'linux', arch: 'x64' },
  startedAt: '2026-11-16T10:00:00.000Z',
  treeAtLaunch: '2222222222222222222222222222222222222222',
  treeAtStop: '3333333333333333333333333333333333333333',
  launch: { exitCode: 0, logPath: 'launch.log' },
  doctor: { exitCode: 0, logPath: 'doctor.log' },
  stop: options.stop ?? null,
  items: options.items,
});

export const createRunDirectory = async (
  registerCleanup: (cleanup: () => Promise<void>) => void,
  run: string,
  options: RunDirectoryOptions,
): Promise<RunDirectory> => {
  const root = await createTemporaryRepository(registerCleanup);
  const directory = await ensureTauDirectory(root, `verification/${run}`);

  await writeFile(
    runRecordPath(directory),
    `${JSON.stringify(validRunRecord(run, options), null, 2)}\n`,
  );

  return { root, directory };
};
