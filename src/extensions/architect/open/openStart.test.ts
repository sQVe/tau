import { expect, it, onTestFinished, vi } from 'vitest';

import { argumentAfter } from '../../../../tests/execFake.js';
import {
  createTemporaryBareRepository,
  createTemporaryRepository,
} from '../../../../tests/gitRepository.js';
import { temporaryTauConfig } from '../../../../tests/tauConfigHarness.js';
import { isBareRootWithoutGitEntry } from '../../../git.js';
import { appCommands, architectArgv, openTool, requestFor } from '../fixtures/openHarness.js';
import { openArchitect } from './open.js';

vi.mock(import('../../../git.js'), { spy: true });

const locationFor = (cleanup: (cleanup: () => void) => void) => {
  const config = temporaryTauConfig(cleanup, 'tau-architect-open-');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });

  return config.location;
};

it('opens the architect in one split to the right of the lead from a bare repository', async () => {
  const root = await createTemporaryBareRepository(onTestFinished);
  const { app, runtime } = openTool(root);

  const result = await openArchitect(
    requestFor(root, locationFor(onTestFinished), runtime, 'Start ME-1611'),
  );

  expect(result).toEqual({ status: 'opened', sessionFile: null, model: 'a/architect' });

  const split = app.calls.find((call) => call.commandArguments[1] === 'pane.split');
  const splitArguments = split?.commandArguments ?? [];

  const argv = architectArgv(app);
  const folderArguments = argv.slice(0, 3);

  expect(argumentAfter(splitArguments, '--pane')).toBe('p-lead');
  expect(argumentAfter(splitArguments, '--direction')).toBe('right');
  expect(folderArguments).toEqual(['env', '-C', root]);
  expect(appCommands(app)).toEqual(['ls', 'pane.split']);
});

it('starts from a repository with a .git entry without a bare-root probe', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const { app, runtime } = openTool(root);

  vi.mocked(isBareRootWithoutGitEntry).mockClear();

  const result = await openArchitect(
    requestFor(root, locationFor(onTestFinished), runtime, 'Start ME-1611'),
  );

  expect(result).toEqual({ status: 'opened', sessionFile: null, model: 'a/architect' });
  expect(vi.mocked(isBareRootWithoutGitEntry)).toHaveBeenCalledWith(root);
  expect(appCommands(app)).toEqual(['ls', 'pane.split']);
});
