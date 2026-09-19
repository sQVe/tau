import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished as afterTest, vi } from 'vitest';

import { runClient } from '../src/extensions/subagents/cancellation.js';
import { claudeToolName } from '../src/extensions/subagents/claude.js';
import { WorkerController } from '../src/extensions/subagents/controller.js';
import { resolveClaudeLoadout } from '../src/extensions/subagents/loadout.js';
import { readEvent, readReport, readTask } from '../src/extensions/subagents/records.js';
import {
  claudeConfiguration,
  fixtureApiKey,
  fixtureModel,
  scriptedClaudeApi,
} from './claudeFixture.js';
import type { Script } from './claudeFixture.js';
import { isolatedHerdr } from './isolatedHerdr.js';

const hasHerdr = spawnSync('herdr', ['--version'], { timeout: 2000, stdio: 'ignore' }).status === 0;
const hasClaude =
  spawnSync('claude', ['--version'], { timeout: 5000, stdio: 'ignore' }).status === 0;

const workspaceFixture = (root: string) => {
  mkdirSync(join(root, 'delete-fixture', '.git'), { recursive: true });
  writeFileSync(join(root, 'delete-fixture', '.git', 'sentinel'), 'untouched');
  writeFileSync(join(root, 'source.txt'), 'before\n');
  mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.pi', 'agents', 'claude-worker.md'),
    '---\nname: claude-worker\nrole: editing\ncli: claude\nthinking: low\n---\nComplete only the fixture task.\n',
  );
  writeFileSync(
    join(root, '.pi', 'agents', 'claude-scout.md'),
    '---\nname: claude-scout\nrole: investigation\ncli: claude\nthinking: low\n---\nInvestigate only the fixture question.\n',
  );
  writeFileSync(
    join(root, 'parent.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: 'claude-parent', cwd: root })}\n`,
  );
};

// Scripted responses test Tau and Claude integration, not model judgment.
const editingScript =
  (state: { replied: () => boolean; reported: () => boolean; onReport: () => void }): Script =>
  ({ conversation, tools, index }) => {
    const tool = (suffix: string) =>
      tools.find((name) => name === suffix || name.endsWith(`__${suffix}`)) ?? suffix;
    if (index === 0) {
      return {
        tool: 'Edit',
        input: { file_path: 'source.txt', old_string: 'before', new_string: 'after' },
      };
    }
    if (index === 1) {
      return { tool: 'Bash', input: { command: 'find ./delete-fixture/.git -delete' } };
    }
    if (index === 2) {
      return {
        tool: tool('subagent_question'),
        input: { question: 'May I report the fixture result now?' },
      };
    }
    if (state.reported()) {
      return 'Handover accepted. Stopping.';
    }
    if (!state.replied()) {
      return 'Waiting for the parent reply.';
    }
    state.onReport();

    return {
      tool: tool('subagent_report'),
      input: {
        outcome: 'success',
        summary: 'Claude fixture completed.',
        evidence: [
          `safety denial: ${conversation.includes('BLOCKED by CC Safety Net')}`,
          `parent reply: ${conversation.includes('Yes, report the fixture result.')}`,
          `assigned scope: ${conversation.includes('Complete only the fixture task.')}`,
          `delegation tool offered: ${tools.includes(claudeToolName('subagent'))}`,
        ],
      },
    };
  };

const investigationScript =
  (state: { followUp: () => boolean; onReport: () => void; reported: () => boolean }): Script =>
  ({ conversation, tools, index }) => {
    const tool = (suffix: string) =>
      tools.find((name) => name === suffix || name.endsWith(`__${suffix}`)) ?? suffix;
    if (state.reported()) {
      return 'Handover accepted. Stopping.';
    }
    if (state.followUp()) {
      state.onReport();
      // The resumed conversation still holds the first task and its accepted handover.
      return {
        tool: tool('subagent_report'),
        input: {
          outcome: 'success',
          summary: 'Claude follow-up completed.',
          evidence: [
            `prior handover: ${conversation.includes('Claude investigation fixture completed.')}`,
            `resumed transcript: ${conversation.includes('Read source.txt and report what it holds.')}`,
          ],
        },
      };
    }
    if (index === 0) {
      return { tool: 'Read', input: { file_path: 'source.txt' } };
    }
    if (index > 1) {
      return 'Handover accepted. Stopping.';
    }

    return {
      tool: tool('subagent_report'),
      input: {
        outcome: 'success',
        summary: 'Claude investigation fixture completed.',
        evidence: [`read fixture: ${conversation.includes('before')}`],
      },
    };
  };

it.skipIf(!hasHerdr || !hasClaude)(
  'reports a Claude investigation without editing the fixture',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-claude-scout-')));
    afterTest(() => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    });
    workspaceFixture(root);
    const { configuration } = claudeConfiguration(root, root);
    let followUp = false;
    let reportedFollowUp = false;
    const api = await scriptedClaudeApi(
      investigationScript({
        followUp: () => followUp,
        reported: () => reportedFollowUp,
        onReport: () => {
          reportedFollowUp = true;
        },
      }),
    );
    afterTest(async () => {
      await api.close();
    });
    const { environment, client } = await isolatedHerdr('', {
      CLAUDE_CONFIG_DIR: configuration,
      ANTHROPIC_BASE_URL: api.baseUrl,
      ANTHROPIC_API_KEY: fixtureApiKey,
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    });
    await runClient('herdr', ['integration', 'install', 'claude'], 10_000, undefined, environment);
    const workspace = await client(['workspace', 'create', '--cwd', root, '--no-focus']);
    const paneId = workspace.match(/"root_pane":\{[^}]*"pane_id":"([^"]+)"/)?.[1];
    if (!paneId) {
      throw new Error('Missing parent pane.');
    }
    vi.stubEnv('CLAUDE_CONFIG_DIR', configuration);
    vi.stubEnv('PI_CODING_AGENT_DIR', environment.PI_CODING_AGENT_DIR);
    const loadout = await resolveClaudeLoadout(
      { profile: 'claude-scout', model: fixtureModel, permissions: 'trusted-full-tools' },
      { cwd: root, isProjectTrusted: () => true },
    );
    const finished = Promise.withResolvers<string>();
    let resolveFinished = finished.resolve;
    const controller = new WorkerController(join(root, 'records'), client, (message, question) => {
      if (!question) {
        resolveFinished(message);
      }
    });
    controller.project = { cwd: root, isProjectTrusted: () => true };
    afterTest(() => {
      controller.close();
    });

    const launched = await controller.launch({
      task: 'Read source.txt and report what it holds.',
      loadout,
      timeout: 120_000,
      parentSession: join(root, 'parent.jsonl'),
      parentSessionId: 'claude-parent',
      parentPane: paneId,
    });
    await finished.promise;

    const status = controller.status(launched.taskId, 'claude-parent');
    expect(readReport(launched.directory, launched.taskId)).toMatchObject({
      outcome: 'success',
      evidence: ['read fixture: true'],
    });
    expect(status.name?.startsWith('investigator-')).toBe(true);
    expect(status.stopped).toBe(true);
    expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe('before\n');

    followUp = true;
    const continued = Promise.withResolvers<string>();
    resolveFinished = continued.resolve;
    const successor = await controller.followUp(
      {
        sourceTaskId: launched.taskId,
        task: 'Report the same finding again for the follow-up.',
        timeout: 120_000,
        settingsUnchanged: true,
        parentSession: join(root, 'parent.jsonl'),
        parentSessionId: 'claude-parent',
        parentPane: paneId,
      },
      { cwd: root, isProjectTrusted: () => true, modelRegistry: undefined as never },
    );
    await continued.promise;

    expect(successor.predecessorTaskId).toBe(launched.taskId);
    expect(successor.nativeSessionId).toBe(status.nativeSessionId);
    expect(readReport(successor.directory, successor.taskId)).toMatchObject({
      outcome: 'success',
      summary: 'Claude follow-up completed.',
      evidence: ['prior handover: true', 'resumed transcript: true'],
    });
    expect(readReport(launched.directory, launched.taskId)?.summary).toBe(
      'Claude investigation fixture completed.',
    );
  },
  240_000,
);

it.skipIf(!hasHerdr || !hasClaude)(
  'runs a Claude worker through launch, protected reporting, questions, and cleanup',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-claude-worker-')));
    afterTest(() => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    });
    workspaceFixture(root);
    const { configuration } = claudeConfiguration(root, root);
    let replied = false;
    let reported = false;
    const api = await scriptedClaudeApi(
      editingScript({
        replied: () => replied,
        reported: () => reported,
        onReport: () => {
          reported = true;
        },
      }),
    );
    afterTest(async () => {
      await api.close();
    });

    const { environment, client } = await isolatedHerdr('', {
      CLAUDE_CONFIG_DIR: configuration,
      ANTHROPIC_BASE_URL: api.baseUrl,
      ANTHROPIC_API_KEY: fixtureApiKey,
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    });
    await runClient('herdr', ['integration', 'install', 'claude'], 10_000, undefined, environment);
    const workspace = await client(['workspace', 'create', '--cwd', root, '--no-focus']);
    const paneId = workspace.match(/"root_pane":\{[^}]*"pane_id":"([^"]+)"/)?.[1];
    if (!paneId) {
      throw new Error('Missing parent pane.');
    }

    vi.stubEnv('CLAUDE_CONFIG_DIR', configuration);
    vi.stubEnv('PI_CODING_AGENT_DIR', environment.PI_CODING_AGENT_DIR);
    const loadout = await resolveClaudeLoadout(
      { profile: 'claude-worker', model: fixtureModel, permissions: 'trusted-full-tools' },
      { cwd: root, isProjectTrusted: () => true },
    );
    expect(loadout.permissionMode).toBe('bypassPermissions');

    const questionAsked = Promise.withResolvers<undefined>();
    const finished = Promise.withResolvers<string>();
    const controller = new WorkerController(join(root, 'records'), client, (message, question) => {
      if (question) {
        questionAsked.resolve(undefined);
      } else {
        finished.resolve(message);
      }
    });
    controller.project = { cwd: root, isProjectTrusted: () => true };
    afterTest(() => {
      controller.close();
    });

    const launched = await controller.launch({
      task: 'Edit source.txt and check it.',
      loadout,
      timeout: 120_000,
      parentSession: join(root, 'parent.jsonl'),
      parentSessionId: 'claude-parent',
      parentPane: paneId,
    });
    expect(launched.failure ?? '').toBe('');
    expect(launched.ready).toBe(true);
    expect(readEvent(launched.directory, launched.taskId, 'ready')?.detail).toContain(
      'CC Safety Net denied',
    );

    await questionAsked.promise;
    const pending = controller.status(launched.taskId, 'claude-parent').pendingQuestion;
    expect(pending?.question).toContain('May I report');
    replied = true;
    const receipt = await controller.reply(launched.taskId, 'claude-parent', {
      questionId: pending?.questionId ?? '',
      replyId: 'reply-one',
      reply: 'Yes, report the fixture result.',
      scopeUnchanged: true,
    });
    expect(receipt.replyAccepted).toBe(true);

    const notification = await finished.promise;
    const status = controller.status(launched.taskId, 'claude-parent');
    const report = readReport(launched.directory, launched.taskId);

    expect(report?.outcome).toBe('success');
    expect(report?.evidence).toEqual([
      'safety denial: true',
      'parent reply: true',
      'assigned scope: true',
      'delegation tool offered: true',
    ]);
    expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe('after\n');
    expect(existsSync(join(root, 'delete-fixture', '.git', 'sentinel'))).toBe(true);
    expect(status.accepted).toBe(true);
    expect(status.reportAccepted).toBe(true);
    expect(status.outcome).toBe('success');
    expect(status.stopped).toBe(true);
    expect(status.usage).toMatchObject({ available: true });
    // Check allowed tools too, so an empty tool list cannot pass the denial assertions.
    expect(api.offeredTools()).toEqual(
      expect.arrayContaining([
        'Read',
        'Edit',
        'Bash',
        claudeToolName('subagent'),
        claudeToolName('subagent_report'),
      ]),
    );
    expect(api.offeredTools()).not.toContain('Agent');
    expect(api.offeredTools()).not.toContain('Task');
    expect(api.offeredTools()).not.toContain('AskUserQuestion');
    expect(notification).toContain(launched.taskId);
    expect(status.nativeSessionFile).toBe(readTask(launched.directory).nativeSessionFile);
    expect(existsSync(status.nativeSessionFile)).toBe(true);
    expect(api.failures).toEqual([]);
  },
  180_000,
);
