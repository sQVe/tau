import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryTauConfig } from '../../../tests/tauConfigHarness.js';
import type { ConfigWarnings } from '../../config/config.js';
import { readQaSettings } from './qaSettings.js';

const ui = { notify: () => undefined };
const repository = 'sQVe/cape';

const entry = {
  urlCommand: './scripts/dev-url',
  testAccountCommand: 'op read op://dev/cape/login',
  dataWrites: true,
};

it('reads the entry of the repository from the user file', () => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-qa-settings-');

  writeUser({ qa: { repositories: { [repository]: entry } } });

  expect(readQaSettings(location, ui, repository)).toMatchObject(entry);
});

it('matches the repository ignoring case and defaults dataWrites to false', () => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-qa-settings-');

  writeUser({ qa: { repositories: { 'sqve/CAPE': { urlCommand: './dev-url' } } } });

  expect(readQaSettings(location, ui, repository)).toMatchObject({
    urlCommand: './dev-url',
    testAccountCommand: undefined,
    dataWrites: false,
  });
});

it.each([
  { condition: 'the user file is missing', user: undefined, name: repository },
  { condition: 'qa is not set', user: { tracker: {} }, name: repository },
  { condition: 'qa has no repositories', user: { qa: {} }, name: repository },
  {
    condition: 'the repository has no entry',
    user: { qa: { repositories: { 'sQVe/tau': entry } } },
    name: repository,
  },
  { condition: 'the repository is unknown', user: { qa: { repositories: {} } }, name: undefined },
])('reads no settings when $condition', ({ user, name }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-qa-settings-');

  if (user !== undefined) {
    writeUser(user);
  }

  expect(readQaSettings(location, ui, name)).toBeUndefined();
});

it.each([
  { condition: 'qa is not an object', qa: 'on', error: 'qa must be an object' },
  { condition: 'repositories is a list', qa: { repositories: [] }, error: 'keyed by owner/name' },
  {
    condition: 'the entry is not an object',
    qa: { repositories: { [repository]: 'x' } },
    error: `qa.repositories.${repository} must be an object`,
  },
  {
    condition: 'urlCommand is not a string',
    qa: { repositories: { [repository]: { urlCommand: 1 } } },
    error: 'urlCommand must be a string',
  },
  {
    condition: 'testAccountCommand is empty',
    qa: { repositories: { [repository]: { testAccountCommand: ' ' } } },
    error: 'testAccountCommand is empty',
  },
  {
    condition: 'dataWrites is not a boolean',
    qa: { repositories: { [repository]: { dataWrites: 'yes' } } },
    error: 'dataWrites must be true or false',
  },
  {
    condition: 'two keys differ only in case',
    qa: { repositories: { 'sQVe/cape': entry, 'sqve/cape': entry } },
    error: 'name the same repository',
  },
])('refuses settings when $condition', ({ qa, error }) => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-qa-settings-');

  writeUser({ qa });

  expect(() => readQaSettings(location, ui, repository)).toThrow(error);
});

it('ignores a bad entry for another repository', () => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-qa-settings-');

  writeUser({
    qa: { repositories: { 'sQVe/tau': { dataWrites: 'no' }, [repository]: { dataWrites: true } } },
  });

  expect(readQaSettings(location, ui, repository)).toMatchObject({ dataWrites: true });
});

it('refuses qa set in a repository file', () => {
  const { location, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-qa-settings-',
  );

  writeUser({ qa: { repositories: { [repository]: entry } } });
  writeRepository({ qa: { repositories: { [repository]: { urlCommand: './evil' } } } });

  expect(() => readQaSettings(location, ui, repository)).toThrow(
    'may be set only in the user file',
  );
});

it('reads the entry past unknown keys and warns about them', () => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-qa-settings-');
  const notify = vi.fn<ConfigWarnings['notify']>();

  writeUser({
    qa: { password: 'x', repositories: { [repository]: { ...entry, password: 'x' } } },
  });

  expect(readQaSettings(location, { notify }, repository)).toMatchObject(entry);

  expect(notify).toHaveBeenCalledWith(expect.stringContaining('qa.password'), 'warning');

  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining(`qa.repositories.${repository}.password`),
    'warning',
  );
});

it('refuses a matched entry key that is not owner/name', () => {
  const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-qa-settings-');

  writeUser({ qa: { repositories: { tau: entry } } });

  expect(() => readQaSettings(location, ui, 'tau')).toThrow(
    '"tau" in qa.repositories must be an owner/name',
  );
});
