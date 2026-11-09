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

it('fails a fullCheck key in the user file even when the repository file sets one', () => {
  const { location, writeUser, writeRepository, userFile } = fixture();

  writeUser({ fullCheck: { argv: ['pnpm', 'check'] } });
  writeRepository({ fullCheck: { argv: ['pnpm', 'check'] } });

  expect(() => readRepositoryArgv(location, ui, 'fullCheck')).toThrow(
    `Invalid Tau config ${userFile}: fullCheck belongs in .pi/tau.json`,
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
  { name: 'the repository file is missing', value: undefined, scope: 'checkout' },
  {
    name: 'fullCheck sets no lock scope',
    value: { fullCheck: { argv: ['x'] } },
    scope: 'checkout',
  },
  {
    name: 'fullCheck sets the checkout scope',
    value: { fullCheck: { argv: ['x'], lockScope: 'checkout' } },
    scope: 'checkout',
  },
  {
    name: 'fullCheck sets the repository scope',
    value: { fullCheck: { argv: ['x'], lockScope: 'repository' } },
    scope: 'repository',
  },
  {
    name: 'only the mutation section sets a scope',
    value: { mutation: { argv: ['x'], lockScope: 'repository' } },
    scope: 'checkout',
  },
])('reads the $scope lock scope when $name', ({ value, scope }) => {
  const { location, writeRepository } = fixture();

  if (value !== undefined) {
    writeRepository(value);
  }

  expect(readLockScope(location)).toBe(scope);
});

it('ignores the repository lock scope of an untrusted project', () => {
  const { location, writeRepository } = fixture();

  writeRepository({ fullCheck: { argv: ['x'], lockScope: 'repository' } });

  expect(readLockScope({ ...location, projectTrusted: false })).toBe('checkout');
});

it.each([
  { name: 'an unknown scope', lockScope: 'machine', field: 'fullCheck.lockScope' },
  { name: 'a non-string scope', lockScope: 1, field: 'fullCheck.lockScope' },
  { name: 'a fullCheck string', section: 'pnpm check', field: 'fullCheck' },
])('fails naming the repository file and $field for $name', ({ lockScope, section, field }) => {
  const { location, writeRepository, repositoryFile } = fixture();

  writeRepository({ fullCheck: section ?? { argv: ['x'], lockScope } });

  expect(() => readLockScope(location)).toThrow(`Invalid Tau config ${repositoryFile}: ${field} `);
});

it('warns about a lock scope in the mutation section but not in the fullCheck section', () => {
  const { location, writeRepository } = fixture();
  const notify = vi.fn<ConfigWarnings['notify']>();

  writeRepository({
    fullCheck: { argv: ['x'], lockScope: 'repository' },
    mutation: { argv: ['y'], lockScope: 'repository' },
  });

  readRepositoryArgv(location, { notify }, 'fullCheck');
  readRepositoryArgv(location, { notify }, 'mutation');

  const messages = notify.mock.calls.map(([message]) => message);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('mutation.lockScope');
});
