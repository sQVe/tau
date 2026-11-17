import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryTauConfig } from '../../tests/tauConfigHarness.js';
import type { ConfigWarnings } from './config.js';
import { readVerificationTarget } from './verificationTargets.js';

const fixture = () => temporaryTauConfig(onTestFinished, 'tau-verification-targets-');

const ui = { notify: () => undefined };

it('reads a chosen target from the repository file in a trusted project', () => {
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

  expect(readVerificationTarget(location, ui, 'app')).toEqual({
    kind: 'configured',
    target: app,
  });

  expect(readVerificationTarget(location, ui, 'sandbox')).toEqual({
    kind: 'configured',
    target: sandbox,
  });
});

it('reads a valid target when a second target is malformed', () => {
  const { location, writeRepository } = fixture();

  const app = { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] };

  writeRepository({
    verification: {
      targets: {
        app,
        broken: { launch: ['pnpm'] },
      },
    },
  });

  expect(readVerificationTarget(location, ui, 'app')).toEqual({
    kind: 'configured',
    target: app,
  });
});

it('returns unknown with the sorted names when the chosen target is missing', () => {
  const { location, writeRepository } = fixture();

  writeRepository({
    verification: {
      targets: {
        sandbox: { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] },
        app: { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] },
      },
    },
  });

  expect(readVerificationTarget(location, ui, 'missing')).toEqual({
    kind: 'unknown',
    names: ['app', 'sandbox'],
  });
});

it('rejects a malformed chosen target even when another target is valid', () => {
  const { location, writeRepository, repositoryFile } = fixture();

  writeRepository({
    verification: {
      targets: {
        app: { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] },
        broken: { launch: ['pnpm'] },
      },
    },
  });

  const read = () => readVerificationTarget(location, ui, 'broken');

  expect(read).toThrow(repositoryFile);
  expect(read).toThrow('verification.targets.broken.doctor');
});

it.each([
  {
    name: 'a target without stop',
    target: 'app',
    value: { targets: { app: { launch: ['pnpm'], doctor: ['pnpm'] } } },
    field: 'verification.targets.app.stop',
    example: '["pnpm"',
    reason: 'stop is missing',
  },
  {
    name: 'a target without launch',
    target: 'app',
    value: { targets: { app: { doctor: ['pnpm'], stop: ['pnpm'] } } },
    field: 'verification.targets.app.launch',
    example: '["pnpm", "app:up"]',
    reason: 'launch is missing',
  },
  {
    name: 'an empty launch argv',
    target: 'app',
    value: {
      targets: { app: { launch: [], doctor: ['pnpm'], stop: ['pnpm'] } },
    },
    field: 'verification.targets.app.launch',
    example: '["pnpm"',
    reason: 'must be a non-empty array',
  },
  {
    name: 'a non-string doctor argument',
    target: 'app',
    value: {
      targets: { app: { launch: ['pnpm'], doctor: ['pnpm', 1], stop: ['pnpm'] } },
    },
    field: 'verification.targets.app.doctor',
    example: '["pnpm"',
    reason: 'must be a non-empty array',
  },
  {
    name: 'targets as an array',
    target: 'app',
    value: { targets: [] },
    field: 'verification.targets',
    example: '["pnpm"',
    reason: 'keyed by target name',
  },
  {
    name: 'targets as a string',
    target: 'app',
    value: { targets: 'app' },
    field: 'verification.targets',
    example: '["pnpm"',
    reason: 'keyed by target name',
  },
  {
    name: 'verification as an array',
    target: 'app',
    value: [],
    field: 'verification',
    example: '["pnpm"',
    reason: 'verification must be an object',
  },
  {
    name: 'no targets',
    target: 'app',
    value: {},
    field: 'verification.targets',
    example: '["pnpm"',
    reason: 'targets is missing',
  },
  {
    name: 'empty targets',
    target: 'app',
    value: { targets: {} },
    field: 'verification.targets',
    example: '["pnpm"',
    reason: 'must name at least one target',
  },
  {
    name: 'an invalid target name',
    target: 'App',
    value: {
      targets: { App: { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] } },
    },
    field: 'verification.targets',
    example: '"sandbox"',
    reason: 'must use lower-case letters',
  },
  {
    name: 'a target that is not an object',
    target: 'app',
    value: { targets: { app: true } },
    field: 'verification.targets.app',
    example: '["pnpm"',
    reason: 'must be an object such as',
  },
])('rejects $name', ({ target, value, field, example, reason }) => {
  const { location, writeRepository, repositoryFile } = fixture();

  writeRepository({ verification: value });

  const read = () => readVerificationTarget(location, ui, target);

  expect(read).toThrow(repositoryFile);
  expect(read).toThrow(field);
  expect(read).toThrow(example);
  expect(read).toThrow(reason);
});

it('ignores the repository file in an untrusted project', () => {
  const { location, writeRepository, repositoryFile } = fixture();

  writeRepository({ verification: { targets: {} } });

  expect(readVerificationTarget({ ...location, projectTrusted: false }, ui, 'app')).toEqual({
    kind: 'notConfigured',
    ignored: repositoryFile,
  });
});

it('gives no target when the repository file has no verification key', () => {
  const { location, writeRepository } = fixture();

  writeRepository({ mutation: { argv: ['pnpm', 'test'] } });

  expect(readVerificationTarget(location, ui, 'app')).toEqual({
    kind: 'notConfigured',
    ignored: undefined,
  });
});

it('rejects verification in the user file', () => {
  const { location, writeUser, writeRepository, userFile } = fixture();
  const targets = { app: { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] } };

  writeUser({ verification: { targets } });
  writeRepository({ verification: { targets } });

  const read = () => readVerificationTarget(location, ui, 'app');

  expect(read).toThrow(userFile);
  expect(read).toThrow('verification belongs in .pi/tau.json');
});

it('warns once about an unknown key and still reads the target', () => {
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

  const first = readVerificationTarget(location, session, 'app');
  const second = readVerificationTarget(location, session, 'app');

  const messages = notify.mock.calls.map(([message]) => message);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(repositoryFile);
  expect(messages[0]).toContain('verification.targets.app.drive');

  const expected = { launch: ['pnpm'], doctor: ['pnpm'], stop: ['pnpm'] };

  expect(first).toEqual({ kind: 'configured', target: expected });
  expect(second).toEqual({ kind: 'configured', target: expected });
});
