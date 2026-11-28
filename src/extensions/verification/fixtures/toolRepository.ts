import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { createVerificationTool } from '../tool.js';

interface FixtureOptions {
  doctorExitCode?: number;
  launchScript?: string;
}

interface ToolInput {
  action: 'launch' | 'register' | 'stop';
  target?: string;
  run?: string;
  items?: { item: string; steps: number }[];
}

type ToolResult = ReturnType<ReturnType<typeof createVerificationTool>['execute']>;

type ToolRun = (
  input: ToolInput,
  deadlineMilliseconds?: number,
  signal?: AbortSignal,
) => ToolResult;

interface ToolRepository {
  root: string;
  directory: string;
  seen: string;
  marker: string;
  run: ToolRun;
  runIn: (cwd: string) => ToolRun;
}

export const replaceStopCommand = async (configPath: string, stop: string[]): Promise<void> => {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    verification: { targets: { app: { stop: string[] } } };
  };

  config.verification.targets.app.stop = stop;
  await writeFile(configPath, JSON.stringify(config));
};

export const createToolRepository = async (
  registerCleanup: typeof onTestFinished,
  options: FixtureOptions = {},
): Promise<ToolRepository> => {
  const directory = temporaryDirectory(registerCleanup, 'tau-verification-tool-');

  const root = await realpath(
    await createTemporaryRepository(registerCleanup, 'tau-verification-tool-repo-'),
  );

  const seen = join(directory, 'seen.txt');
  const marker = join(directory, 'stopped');

  await writeFile(seen, '');
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await mkdir(join(root, '.pi'));

  const record = `printf '%s|%s\\n' "$TAU_VERIFICATION_RUN" "$TAU_VERIFICATION_DIRECTORY" >> ${JSON.stringify(seen)}`;
  const launch = options.launchScript ?? `${record}; exit 0`;
  const doctor = `${record}; exit ${options.doctorExitCode ?? 0}`;
  const stop = `${record}; touch ${JSON.stringify(marker)}; exit 0`;

  await writeFile(
    join(root, '.pi', 'tau.json'),
    JSON.stringify({
      verification: {
        targets: {
          app: {
            launch: ['sh', '-c', launch],
            doctor: ['sh', '-c', doctor],
            stop: ['sh', '-c', stop],
          },
        },
      },
    }),
  );

  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');

  const runIn =
    (cwd: string) => (input: ToolInput, deadlineMilliseconds?: number, signal?: AbortSignal) =>
      createVerificationTool({
        agentDirectory: directory,
        ...(deadlineMilliseconds === undefined ? {} : { deadlineMilliseconds }),
      }).execute('call', input, signal, undefined, {
        cwd,
        isProjectTrusted: () => true,
        ui: { notify: () => undefined },
      } as never);

  return { root, directory, seen, marker, run: runIn(root), runIn };
};
