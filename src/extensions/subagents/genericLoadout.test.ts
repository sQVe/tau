import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
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
  const confirm = vi.fn<ExtensionContext['ui']['confirm']>().mockResolvedValue(true);
  const context = {
    cwd: directory,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { confirm },
  } as unknown as ExtensionContext;
  const parent = { getAllTools: () => [], getCommands: () => [] };
  const request = { profile: 'worker', harness: 'codex', permissions: 'native-controls' };

  return { directory, context, parent, request, confirm };
};

it.each(['claude', 'codex', 'gemini'])(
  'resolves %s through the user-approved native-controls contract',
  async (harness) => {
    const setup = fixture();

    const resolved = await resolveLoadout(
      { ...setup.request, harness },
      setup.context,
      setup.parent,
    );

    expect(resolved).toEqual({
      harness: 'generic',
      kind: harness,
      profile: 'worker',
      role: 'editing',
      cwd: setup.directory,
      permissions: 'native-controls',
      arguments: [],
      reportDirectory: setup.directory,
      configurationApproved: true,
      instructions: resolved.instructions,
    });
    expect(resolved.instructions).toBeTypeOf('string');
    expect(setup.confirm).toHaveBeenCalledExactlyOnceWith(
      'Approve native worker configuration?',
      expect.stringContaining('Tau does not certify'),
      expect.anything(),
    );
  },
);

it('refuses unapproved arguments and unsupported verified guarantees before launch', async () => {
  const setup = fixture();
  setup.confirm.mockResolvedValue(false);
  const request = {
    ...setup.request,
    nativeArguments: ['--model', 'requested'],
    model: 'requested',
  };

  await expect(resolveLoadout(request, setup.context, setup.parent)).rejects.toThrow(
    'not approved',
  );
  await expect(
    resolveLoadout({ ...request, permissions: 'trusted-full-tools' }, setup.context, setup.parent),
  ).rejects.toThrow('native-controls');
  await expect(
    resolveLoadout({ ...setup.request, model: 'requested' }, setup.context, setup.parent),
  ).rejects.toThrow('approved native arguments');
});

it('captures native arguments before approval and never takes configuration authority from profiles', async () => {
  const setup = fixture();
  const nativeArguments = ['--model', 'requested; not shell text'];
  const request = { ...setup.request, nativeArguments, model: 'requested' };
  setup.confirm.mockImplementation(async () => {
    nativeArguments.push('--unexpected');

    return true;
  });

  const resolved = await resolveLoadout(request, setup.context, setup.parent);

  expect(resolved).toMatchObject({
    arguments: ['--model', 'requested; not shell text'],
    requestedModel: 'requested',
  });
  mkdirSync(join(setup.directory, 'agents'));
  writeFileSync(
    join(setup.directory, 'agents', 'worker.md'),
    '---\nname: worker\nrole: editing\ncli: codex\nmodel: profile-model\n---\nTask guidance.\n',
  );
  await expect(resolveLoadout(setup.request, setup.context, setup.parent)).rejects.toThrow(
    'approved native arguments',
  );
});

it('refuses report scope expansion, invalid native arguments, and profile thinking translation', async () => {
  const setup = fixture();

  await expect(
    resolveLoadout({ ...setup.request, reportDirectory: '..' }, setup.context, setup.parent),
  ).rejects.toThrow('inside the authorized cwd');
  await expect(
    resolveLoadout(
      { ...setup.request, nativeArguments: ['unsafe\u0000argument'] },
      setup.context,
      setup.parent,
    ),
  ).rejects.toThrow('Invalid or oversized');
  mkdirSync(join(setup.directory, 'agents'));
  writeFileSync(
    join(setup.directory, 'agents', 'worker.md'),
    '---\nname: worker\nrole: editing\ncli: codex\nthinking: high\n---\nTask guidance.\n',
  );
  await expect(resolveLoadout(setup.request, setup.context, setup.parent)).rejects.toThrow(
    'Native thinking settings',
  );
  expect(setup.confirm).not.toHaveBeenCalled();
});

it('preserves cancellation before and during native configuration approval', async () => {
  const setup = fixture();
  const reason = new Error('Approval deadline expired.');

  await expect(
    resolveLoadout(setup.request, setup.context, setup.parent, AbortSignal.abort(reason)),
  ).rejects.toBe(reason);
  expect(setup.confirm).not.toHaveBeenCalled();
  const cancellation = new AbortController();
  setup.confirm.mockImplementation(async () => {
    cancellation.abort(reason);

    return true;
  });
  await expect(
    resolveLoadout(setup.request, setup.context, setup.parent, cancellation.signal),
  ).rejects.toBe(reason);
});
