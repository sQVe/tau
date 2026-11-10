import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryTauConfig } from '../../tests/tauConfigHarness.js';
import type { ConfigWarnings } from './config.js';
import { readLockScope, readRepositoryArgv } from './repositoryCommand.js';

const fixture = () => temporaryTauConfig(onTestFinished, 'tau-full-check-config-');

const ui = { notify: () => undefined };

it('reads the command from the repository file in a trusted project', () => {
  const { location, writeRepository } = fixture();

  writeRepository({ fullCheck: { argv: ['pnpm', 'check'] } });

  expect(readRepositoryArgv(location, ui, 'fullCheck')).toEqual({
    argv: ['pnpm', 'check'],
    ignored: undefined,
  });
});

it.each([
  {
    name: 'the repository file is missing',
    value: undefined,
    projectTrusted: true,
    ignored: false,
  },
  {
    name: 'the repository file has no fullCheck key',
    value: { other: 1 },
    projectTrusted: true,
    ignored: false,
  },
  {
    name: 'the project is not trusted',
    value: { fullCheck: { argv: ['pnpm', 'check'] } },
    projectTrusted: false,
    ignored: true,
  },
  {
    name: 'the project is not trusted and has no file',
    value: undefined,
    projectTrusted: false,
    ignored: false,
  },
])('gives no command when $name', ({ value, projectTrusted, ignored }) => {
  const { location, writeRepository, repositoryFile } = fixture();

  if (value !== undefined) {
    writeRepository(value);
  }

  expect(readRepositoryArgv({ ...location, projectTrusted }, ui, 'fullCheck')).toEqual({
    argv: undefined,
    ignored: ignored ? repositoryFile : undefined,
  });
});

it.each([
  { name: 'argv', section: { argv: ['pnpm', 'check'] } },
  { name: 'lockScope', section: { lockScope: 'repository' } },
  { name: 'an unknown key', section: { other: true } },
  { name: 'argv alongside repositories', section: { argv: ['x'], repositories: {} } },
  { name: 'a null section', section: null },
  { name: 'an array section', section: [] },
])('rejects $name in the user fullCheck section', ({ section }) => {
  const { location, writeUser, writeRepository, userFile } = fixture();

  writeUser({ fullCheck: section });
  writeRepository({ fullCheck: { argv: ['pnpm', 'check'] } });

  expect(() => readRepositoryArgv(location, ui, 'fullCheck')).toThrow(
    `Invalid Tau config ${userFile}: fullCheck belongs in .pi/tau.json`,
  );
});

it('rejects repository settings in the user mutation section', () => {
  const { location, writeUser, writeRepository, userFile } = fixture();

  writeUser({ mutation: { repositories: {} } });
  writeRepository({ mutation: { argv: ['x'] } });

  expect(() => readRepositoryArgv(location, ui, 'mutation')).toThrow(
    `Invalid Tau config ${userFile}: mutation belongs in .pi/tau.json`,
  );
});

it('warns once about an unknown key and still reads the command', () => {
  const { location, writeRepository, repositoryFile } = fixture();
  const notify = vi.fn<ConfigWarnings['notify']>();
  const session = { notify };

  writeRepository({ fullCheck: { argv: ['pnpm', 'check'], timeout: 5 } });

  expect(readRepositoryArgv(location, session, 'fullCheck').argv).toEqual(['pnpm', 'check']);
  expect(readRepositoryArgv(location, session, 'fullCheck').argv).toEqual(['pnpm', 'check']);

  const messages = notify.mock.calls.map(([message]) => message);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(repositoryFile);
  expect(messages[0]).toContain('fullCheck.timeout');
});

it.each([
  { name: 'fullCheck is a string', value: 'pnpm check', field: 'fullCheck' },
  { name: 'fullCheck is null', value: null, field: 'fullCheck' },
  { name: 'argv is missing', value: {}, field: 'fullCheck.argv' },
  { name: 'argv is empty', value: { argv: [] }, field: 'fullCheck.argv' },
  { name: 'argv has an empty string', value: { argv: ['pnpm', ''] }, field: 'fullCheck.argv' },
  { name: 'argv has a non-string', value: { argv: ['pnpm', 1] }, field: 'fullCheck.argv' },
  { name: 'argv is a string', value: { argv: 'pnpm check' }, field: 'fullCheck.argv' },
])('fails naming the repository file and $field when $name', ({ value, field }) => {
  const { location, writeRepository, repositoryFile } = fixture();

  writeRepository({ fullCheck: value });

  expect(() => readRepositoryArgv(location, ui, 'fullCheck')).toThrow(
    `Invalid Tau config ${repositoryFile}: ${field} `,
  );
});

it.each([
  { name: 'the user file is missing', value: undefined, scope: 'checkout' },
  { name: 'the user section is missing', value: {}, scope: 'checkout' },
  { name: 'repositories is missing', value: { fullCheck: {} }, scope: 'checkout' },
  {
    name: 'the entry has no scope',
    value: { fullCheck: { repositories: { 'owner/name': {} } } },
    scope: 'checkout',
  },
  {
    name: 'another repository sets a scope',
    value: { fullCheck: { repositories: { 'other/repo': { lockScope: 'repository' } } } },
    scope: 'checkout',
  },
  {
    name: 'fullCheck sets the checkout scope',
    value: { fullCheck: { repositories: { 'Owner/Name': { lockScope: 'checkout' } } } },
    scope: 'checkout',
  },
  {
    name: 'fullCheck sets the repository scope',
    value: { fullCheck: { repositories: { 'Owner/Name': { lockScope: 'repository' } } } },
    scope: 'repository',
  },
  {
    name: 'only the mutation section sets a scope',
    value: { mutation: { argv: ['x'], lockScope: 'repository' } },
    scope: 'checkout',
  },
])('reads the $scope lock scope when $name', ({ value, scope }) => {
  const { location, writeUser } = fixture();
  const notify = vi.fn<ConfigWarnings['notify']>();

  if (value !== undefined) {
    writeUser(value);
  }

  expect(readLockScope(location, { notify }, 'owner/name')).toBe(scope);
  expect(notify).not.toHaveBeenCalled();
});

it('ignores the repository lock scope in a trusted project', () => {
  const { location, writeRepository } = fixture();

  writeRepository({ fullCheck: { argv: ['x'], lockScope: 'repository' } });

  expect(readLockScope(location, ui, 'owner/name')).toBe('checkout');
});

it.each([
  {
    name: 'an unknown scope',
    entry: { lockScope: 'machine' },
    field: 'fullCheck.repositories.owner/name.lockScope',
  },
  {
    name: 'a non-string scope',
    entry: { lockScope: 1 },
    field: 'fullCheck.repositories.owner/name.lockScope',
  },
  { name: 'a non-object entry', entry: 'repository', field: 'fullCheck.repositories.owner/name' },
])('fails naming the user file and $field for $name', ({ entry, field }) => {
  const { location, writeUser, userFile } = fixture();

  writeUser({ fullCheck: { repositories: { 'owner/name': entry } } });

  expect(() => readLockScope(location, ui, 'owner/name')).toThrow(
    `Invalid Tau config ${userFile}: ${field} `,
  );
});

it('reads user lock scope in an untrusted project and permits repository commands', () => {
  const { location, writeUser, writeRepository } = fixture();

  writeUser({ fullCheck: { repositories: { 'owner/name': { lockScope: 'repository' } } } });
  writeRepository({ fullCheck: { argv: ['x'] } });

  expect(readLockScope({ ...location, projectTrusted: false }, ui, 'owner/name')).toBe(
    'repository',
  );

  expect(readLockScope(location, ui, undefined)).toBe('checkout');
  expect(readRepositoryArgv(location, ui, 'fullCheck').argv).toEqual(['x']);
});

it('warns about repository lock scope keys in both command sections', () => {
  const { location, writeRepository } = fixture();
  const notify = vi.fn<ConfigWarnings['notify']>();

  writeRepository({
    fullCheck: { argv: ['x'], lockScope: 'repository', repositories: {} },
    mutation: { argv: ['y'], lockScope: 'repository' },
  });

  readRepositoryArgv(location, { notify }, 'fullCheck');
  readRepositoryArgv(location, { notify }, 'mutation');

  const messages = notify.mock.calls.map(([message]) => message);

  expect(messages).toHaveLength(3);
  expect(messages[0]).toContain('fullCheck.lockScope');
  expect(messages[1]).toContain('fullCheck.repositories');
  expect(messages[2]).toContain('mutation.lockScope');
});
