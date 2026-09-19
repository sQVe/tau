import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished as afterTest, vi } from 'vitest';

import { inheritedInstructions } from './admission.js';
import { claudeToolName } from './claude.js';
import { claudeConfigurationFixture } from './fixtures/claudeConfiguration.js';
import type { ConfigurationOptions } from './fixtures/claudeConfiguration.js';
import {
  resolveClaudeLoadout,
  resolveInheritedClaudeLoadout,
  resolveLoadout,
  validateSavedClaudeLoadout,
} from './loadout.js';
import { validateTask } from './records.js';
import type { ClaudeLoadout, Task } from './types.js';

const fixture = (options: ConfigurationOptions = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-claude-loadout-')));
  afterTest(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const saved = claudeConfigurationFixture(root, options);
  mkdirSync(join(root, 'agent'), { recursive: true });
  vi.stubEnv('CLAUDE_CONFIG_DIR', saved.configuration);
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'));
  vi.stubEnv('PATH', `${saved.binary}:${process.env.PATH ?? ''}`);

  return {
    root,
    ...saved,
    request: {
      profile: 'claude-worker',
      model: 'claude-sonnet-5',
      permissions: 'trusted-full-tools',
    },
    context: { cwd: root, isProjectTrusted: () => true },
  };
};

const savedTask = (loadout: ClaudeLoadout, root: string): Task =>
  validateTask({
    version: 1,
    taskId: 'parent-task',
    task: 'Edit the fixture.',
    parentSession: join(root, 'parent.jsonl'),
    parentSessionId: 'parent',
    ownerId: 'owner',
    nativeSessionId: '11111111-2222-3333-4444-555555555555',
    nativeSessionFile: join(root, 'transcript.jsonl'),
    createdAt: 1,
    deadline: 600_000,
    cancellationBudget: 5000,
    tree: {
      rootSession: join(root, 'parent.jsonl'),
      rootSessionId: 'parent',
      monotonicDeadline: 600_000,
    },
    loadout,
  });

it('resolves a Claude worker from saved configuration without changing it', async () => {
  const setup = fixture();

  const loadout = await resolveClaudeLoadout(setup.request, setup.context);

  expect(loadout).toMatchObject({
    harness: 'claude',
    permissions: 'trusted-full-tools',
    permissionMode: 'bypassPermissions',
    executable: setup.executable,
    executableVersion: '2.1.276 (Claude Code)',
    agentDirectory: setup.configuration,
    safetyArguments: ['hook', '--coding-cli'],
  });
  expect(loadout.tools).toContain(claudeToolName('subagent_report'));
  expect(loadout.integrations).toContain(join(setup.configuration, 'settings.json'));
  expect(loadout.safetyExtension).toBe(join(setup.install, 'dist', 'bin', 'cc-safety-net.js'));
  // Claude reads a local settings file the moment it exists, so an absent one is still recorded.
  expect(loadout.integrations).toContain(join(setup.context.cwd, '.claude', 'settings.local.json'));
});

it('selects the profile harness when the request omits it', async () => {
  const setup = fixture();
  const context = {
    ...setup.context,
    get modelRegistry(): ExtensionContext['modelRegistry'] {
      throw new Error('Claude must not resolve a Pi model.');
    },
  };
  const parent = { getAllTools: () => [], getCommands: () => [] };

  await expect(resolveLoadout(setup.request, context, parent)).resolves.toMatchObject({
    harness: 'claude',
  });
  await expect(
    resolveLoadout({ ...setup.request, harness: 'pi' }, context, parent),
  ).rejects.toThrow('not a Pi one');
});

it('refuses a permission configuration Tau cannot run a worker under', async () => {
  const prompting = fixture({ defaultMode: 'acceptEdits' });
  await expect(resolveClaudeLoadout(prompting.request, prompting.context)).rejects.toThrow(
    'need saved permission mode bypassPermissions',
  );

  const confirming = fixture({ skipPrompt: false });
  await expect(resolveClaudeLoadout(confirming.request, confirming.context)).rejects.toThrow(
    'bypass-permissions confirmation',
  );
});

it('refuses a Claude worker whose safety integration is missing', async () => {
  const disabled = fixture({ plugins: {} });
  await expect(resolveClaudeLoadout(disabled.request, disabled.context)).rejects.toThrow(
    'exactly one enabled cc-safety-net plugin',
  );

  const uninstalled = fixture({ installed: false });
  await expect(resolveClaudeLoadout(uninstalled.request, uninstalled.context)).rejects.toThrow(
    'not installed exactly once',
  );
});

it('refuses a profile pinned to another harness and a model it cannot name', async () => {
  const wrongHarness = fixture({ harness: 'pi' });
  await expect(resolveClaudeLoadout(wrongHarness.request, wrongHarness.context)).rejects.toThrow(
    'not a Claude one',
  );

  const setup = fixture();
  await expect(
    resolveClaudeLoadout({ ...setup.request, model: '' }, setup.context),
  ).rejects.toThrow('Set an exact Claude model');
  await expect(
    resolveClaudeLoadout({ ...setup.request, permissions: 'sandboxed' }, setup.context),
  ).rejects.toThrow('trusted-full-tools');
});

it('refuses saved replay after the worker configuration changed', async () => {
  const setup = fixture();
  const loadout = await resolveClaudeLoadout(setup.request, setup.context);

  await expect(validateSavedClaudeLoadout(loadout, setup.context)).resolves.toMatchObject({
    harness: 'claude',
  });

  writeFileSync(
    join(setup.configuration, 'settings.json'),
    JSON.stringify({
      permissions: { defaultMode: 'bypassPermissions' },
      skipDangerousModePermissionPrompt: true,
      enabledPlugins: { 'cc-safety-net@market': true },
      cleanupPeriodDays: 30,
    }),
  );

  await expect(validateSavedClaudeLoadout(loadout, setup.context)).rejects.toThrow(
    'requires a fresh task',
  );
});

it('refuses saved replay after Claude Code was updated', async () => {
  const setup = fixture();
  const loadout = await resolveClaudeLoadout(setup.request, setup.context);
  writeFileSync(setup.executable, '#!/bin/sh\nprintf "2.2.0 (Claude Code)\\n"\n');
  chmodSync(setup.executable, 0o755);

  await expect(validateSavedClaudeLoadout(loadout, setup.context)).rejects.toThrow(
    'updated after this task was saved',
  );
});

it('keeps nested work inside the parent scope and settings', async () => {
  const setup = fixture();
  const loadout = await resolveClaudeLoadout(setup.request, setup.context);
  const parent = savedTask(loadout, setup.root);

  const nested = await resolveInheritedClaudeLoadout(
    parent,
    loadout,
    { profile: 'claude-worker', permissions: 'trusted-full-tools' },
    setup.context,
  );

  expect(nested.instructions.startsWith(inheritedInstructions(parent))).toBe(true);
  expect({ ...nested, instructions: '' }).toEqual({ ...loadout, instructions: '' });

  await expect(
    resolveInheritedClaudeLoadout(
      parent,
      loadout,
      { profile: 'claude-worker', permissions: 'trusted-full-tools', model: 'claude-other' },
      setup.context,
    ),
  ).rejects.toThrow('exact inherited model');
  await expect(
    resolveInheritedClaudeLoadout(
      parent,
      loadout,
      { profile: 'claude-worker', permissions: 'trusted-full-tools', harness: 'pi' },
      setup.context,
    ),
  ).rejects.toThrow('exact inherited model');
});

it('reads project and local settings as Claude merges them', async () => {
  const setup = fixture();
  mkdirSync(join(setup.root, '.claude'), { recursive: true });
  // A later source turning the safety plugin off leaves the worker unguarded, so the launch refuses.
  writeFileSync(
    join(setup.root, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'cc-safety-net@market': false } }),
  );

  await expect(resolveClaudeLoadout(setup.request, setup.context)).rejects.toThrow(
    'exactly one enabled cc-safety-net plugin',
  );

  writeFileSync(
    join(setup.root, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'cc-safety-net@market': true } }),
  );
  writeFileSync(
    join(setup.root, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }),
  );

  await expect(resolveClaudeLoadout(setup.request, setup.context)).rejects.toThrow(
    'need saved permission mode bypassPermissions',
  );
});
