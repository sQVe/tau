import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryTauConfig } from '../../tests/tauConfigHarness.js';
import type { ConfigWarnings } from './config.js';
import { readVerificationTargets } from './verificationTargets.js';

const fixture = () => temporaryTauConfig(onTestFinished, 'tau-verification-targets-');

const ui = { notify: () => undefined };

it('reads two targets from the repository file in a trusted project', () => {
  const { location, writeRepository } = fixture();

  const app = {
    launch: ['pnpm', 'app:up'],
    doctor: ['pnpm', 'app:doctor'],
    stop: ['pnpm', 'app:down'],
  };

  const sandbox = {
    launch: ['pnpm', 'sandbox:up'],
    doctor: ['pnpm', 'sandbox:doctor'],
    stop: ['pnpm', 'sandbox:down'],
  };

  writeRepository({ verification: { targets: { app, sandbox } } });

  const result = readVerificationTargets(location, ui);

  expect(result.kind).toBe('configured');

  if (result.kind !== 'configured') {
    throw new Error('expected configured targets');
  }

  expect([...result.targets.entries()]).toEqual([
    ['app', app],
    ['sandbox', sandbox],
  ]);
});

it.each([
  {
    name: 'a target without stop',
    value: { targets: { app: { launch: ['pnpm'], doctor: ['pnpm'] } } },
    field: 'verification.targets.app.stop',
    example: '["pnpm"',
  },
  {
    name: 'an empty launch argv',
    value: {
      targets: { app: { launch: [], doctor: ['pnpm'], stop: ['pnpm'] } },
    },
    field: 'verification.targets.app.launch',
    example: '["pnpm"',
  },
  {
    name: 'a non-string doctor argument',
    value: {
      targets: { app: { launch: ['pnpm'], doctor: ['pnpm', 1], stop: ['pnpm'] } },
    },
    field: 'verification.targets.app.doctor',
    example: '["pnpm"',
  },
  {
    name: 'targets as an array',
    value: { targets: [] },
    field: 'verification.targets',
    example: '["pnpm"',
  },
  {
    name: 'targets as a string',
    value: { targets: 'app' },
    field: 'verification.targets',
    example: '["pnpm"',
  },
  {
    name: 'verification as an array',
    value: [],
    field: 'verification',
    example: '["pnpm"',
  },
  { name: 'no targets', value: {}, field: 'verification.targets', example: '["pnpm"' },
  {
    name: 'empty targets',
    value: { targets: {} },
    field: 'verification.targets',
    example: '["pnpm"',
  },
  {
    name: 'an invalid target name',
    value: {
      targets: { App: { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] } },
    },
    field: 'verification.targets',
    example: '"sandbox"',
  },
  {
    name: 'a target that is not an object',
    value: { targets: { app: true } },
    field: 'verification.targets.app',
    example: '["pnpm"',
  },
])('rejects $name', ({ value, field, example }) => {
  const { location, writeRepository, repositoryFile } = fixture();

  writeRepository({ verification: value });

  const read = () => readVerificationTargets(location, ui);

  expect(read).toThrow(repositoryFile);
  expect(read).toThrow(field);
  expect(read).toThrow(example);
});

it('ignores the repository file in an untrusted project', () => {
  const { location, writeRepository, repositoryFile } = fixture();

  writeRepository({ verification: { targets: {} } });

  expect(readVerificationTargets({ ...location, projectTrusted: false }, ui)).toEqual({
    kind: 'notConfigured',
    ignored: repositoryFile,
  });
});

it('gives no targets when the repository file has no verification key', () => {
  const { location, writeRepository } = fixture();

  writeRepository({ mutation: { argv: ['pnpm', 'test'] } });

  expect(readVerificationTargets(location, ui)).toEqual({
    kind: 'notConfigured',
    ignored: undefined,
  });
});

it('rejects verification in the user file', () => {
  const { location, writeUser, writeRepository, userFile } = fixture();
  const targets = { app: { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] } };

  writeUser({ verification: { targets } });
  writeRepository({ verification: { targets } });

  const read = () => readVerificationTargets(location, ui);

  expect(read).toThrow(userFile);
  expect(read).toThrow('verification belongs in .pi/tau.json');
});

it('warns once about an unknown key and still reads the targets', () => {
  const { location, writeRepository, repositoryFile } = fixture();
  const notify = vi.fn<ConfigWarnings['notify']>();
  const session = { notify };

  const target = {
    launch: ['pnpm'],
    doctor: ['pnpm'],
    stop: ['pnpm'],
    drive: ['x'],
  };

  writeRepository({ verification: { targets: { app: target } } });

  const first = readVerificationTargets(location, session);
  const second = readVerificationTargets(location, session);

  const messages = notify.mock.calls.map(([message]) => message);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(repositoryFile);
  expect(messages[0]).toContain('verification.targets.app.drive');

  if (first.kind !== 'configured' || second.kind !== 'configured') {
    throw new Error('expected configured targets');
  }

  const expected = { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] };

  expect(first.targets.get('app')).toEqual(expected);
  expect(second.targets.get('app')).toEqual(expected);
});
