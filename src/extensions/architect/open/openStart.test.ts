import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { installCommandShim, logCommandCalls } from '../../../../tests/commandShimFake.js';
import { argumentAfter } from '../../../../tests/execFake.js';
import {
  createTemporaryBareRepository,
  createTemporaryRepository,
} from '../../../../tests/gitRepository.js';
import { temporaryTauConfig } from '../../../../tests/tauConfigHarness.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { appCommands, architectArgv, openTool } from '../fixtures/openHarness.js';
import { openArchitect } from './open.js';
import type { OpenRequest } from './open.js';

const locationFor = (cleanup: (cleanup: () => void) => void) => {
  const config = temporaryTauConfig(cleanup, 'tau-architect-open-');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });

  return config.location;
};

const requestFor = (
  root: string,
  location: OpenRequest['location'],
  hc: OpenRequest['hc'],
): OpenRequest => ({
  root,
  leadTerminal: 't-lead',
  request: 'Start ME-1611',
  location,
  ui: { notify: vi.fn<() => void>() },
  hc,
});

it('starts the architect from a real bare repository left of the lead', async () => {
  const root = await createTemporaryBareRepository(onTestFinished);
  const { app, runtime } = openTool(root);

  const result = await openArchitect(requestFor(root, locationFor(onTestFinished), runtime));

  expect(result).toEqual({ status: 'opened', sessionFile: null });

  const split = app.calls.find((call) => call.commandArguments[1] === 'pane.split');
  const splitArguments = split?.commandArguments ?? [];

  const argv = architectArgv(app);
  const folderArguments = argv.slice(0, 3);

  expect(argumentAfter(splitArguments, '--pane')).toBe('p-lead');
  expect(folderArguments).toEqual(['env', '-C', root]);
  expect(appCommands(app)).toEqual(['ls', 'pane.split', 'pane.swap']);
});

it('starts from a repository with a .git entry without asking Git whether it is bare', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const { runtime } = openTool(root);
  const logPath = join(temporaryDirectory(onTestFinished, 'tau-architect-git-calls-'), 'calls.log');

  await writeFile(logPath, '');
  await installCommandShim('git', { otherCalls: 'real', overrides: [logCommandCalls(logPath)] });

  await openArchitect(requestFor(root, locationFor(onTestFinished), runtime));

  expect(await readFile(logPath, 'utf8')).toBe('');
});
