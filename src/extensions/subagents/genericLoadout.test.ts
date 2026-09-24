import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { resolveLoadout } from './loadout.js';

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-native-loadout-'));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_SUBAGENT_MODEL', 'ignored/environment');
  const context = {
    cwd: directory,
    isProjectTrusted: () => true,
    modelRegistry: undefined as never,
    scopedModels: [],
  };
  const request = { profile: 'worker', harness: 'codex', permissions: 'native-controls' };

  return { directory, context, request };
};

it.each(['claude', 'codex', 'gemini'])(
  'resolves %s through the native-controls contract',
  async (harness) => {
    const setup = fixture();

    const resolved = resolveLoadout({ ...setup.request, harness }, setup.context);

    expect(resolved).toEqual({
      harness: 'generic',
      kind: harness,
      profile: 'worker',
      role: 'editing',
      cwd: setup.directory,
      permissions: 'native-controls',
      arguments: [],
      reportDirectory: setup.directory,
      instructions: resolved.instructions,
    });
    expect(resolved.instructions).toBeTypeOf('string');
  },
);

it('refuses unsupported verified guarantees and bare model requests before launch', async () => {
  const setup = fixture();
  const request = {
    ...setup.request,
    nativeArguments: ['--model', 'requested'],
    model: 'requested',
  };

  expect(() =>
    resolveLoadout({ ...request, permissions: 'trusted-full-tools' }, setup.context),
  ).toThrow('native-controls');
  expect(() => resolveLoadout({ ...setup.request, model: 'requested' }, setup.context)).toThrow(
    'native arguments',
  );
});

it('copies native arguments literally and never takes configuration authority from profiles', async () => {
  const setup = fixture();
  const nativeArguments = ['--model', 'requested; not shell text'];
  const request = { ...setup.request, nativeArguments, model: 'requested' };

  const resolved = resolveLoadout(request, setup.context);
  nativeArguments.push('--unexpected');

  expect(resolved).toMatchObject({
    arguments: ['--model', 'requested; not shell text'],
    requestedModel: 'requested',
  });
  mkdirSync(join(setup.directory, 'agents'));
  writeFileSync(
    join(setup.directory, 'agents', 'worker.md'),
    '---\nname: worker\nrole: editing\ncli: codex\nmodel: profile-model\n---\nTask guidance.\n',
  );
  expect(() => resolveLoadout(setup.request, setup.context)).toThrow('native arguments');
});

it('refuses report scope expansion, invalid native arguments, and profile thinking translation', async () => {
  const setup = fixture();

  expect(() => resolveLoadout({ ...setup.request, reportDirectory: '..' }, setup.context)).toThrow(
    'inside the authorized cwd',
  );
  expect(() =>
    resolveLoadout({ ...setup.request, nativeArguments: ['unsafe\u0000argument'] }, setup.context),
  ).toThrow('Invalid or oversized');
  mkdirSync(join(setup.directory, 'agents'));
  writeFileSync(
    join(setup.directory, 'agents', 'worker.md'),
    '---\nname: worker\nrole: editing\ncli: codex\nthinking: high\n---\nTask guidance.\n',
  );
  expect(() => resolveLoadout(setup.request, setup.context)).toThrow('Native thinking settings');
});

it('preserves cancellation before native configuration', async () => {
  const setup = fixture();
  const reason = new Error('Launch deadline expired.');

  expect(() => resolveLoadout(setup.request, setup.context, AbortSignal.abort(reason))).toThrow(
    reason,
  );
});
