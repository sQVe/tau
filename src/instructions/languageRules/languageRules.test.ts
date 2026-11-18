import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { writeStommeProject } from '../../../tests/stommeProjectHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { trackGuideRuns } from '../guideRuns.js';
import type { GuideLanguage } from '../stommeGuides/stommeGuidesDecision.js';
import { registerLanguageRules } from './languageRules.js';

interface Case {
  language: GuideLanguage;
  label: string;
  customType: string;
  path: string;
  command: string;
}

const cases: Case[] = [
  {
    language: 'typescript',
    label: 'TypeScript',
    customType: 'tau-typescript-rules',
    path: 'main.ts',
    command: 'typescript-rules',
  },
  {
    language: 'rust',
    label: 'Rust',
    customType: 'tau-rust-rules',
    path: 'src/lib.rs',
    command: 'rust-rules',
  },
];

const bundleDirectory = fileURLToPath(new URL('../../../vendor/stomme', import.meta.url));

const bundledRules = (language: GuideLanguage): string => {
  const path = `languages/${language}/guide.md`;
  const text = readFileSync(join(bundleDirectory, path), 'utf8');

  return `Source: ${bundleDirectory}/${path}\n\n${text.trim()}`;
};

const setup = async (onTestFinished: TestContext['onTestFinished']) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-language-rules-');
  const sessionManager = SessionManager.inMemory();

  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>((type, data) => {
    sessionManager.appendCustomEntry(type, data);
  });

  const api = fakeExtensionApi({ appendEntry });
  const idle = vi.fn<ExtensionContext['isIdle']>(() => false);
  const notify = vi.fn<ExtensionContext['ui']['notify']>();

  const context = {
    cwd: directory,
    sessionManager,
    isIdle: idle,
    ui: { notify },
  } as unknown as ExtensionContext;

  const guideRuns = trackGuideRuns(api.pi);

  registerLanguageRules(api.pi, guideRuns);

  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    const results: unknown[] = [];
    const current = { ...event };

    for (const handler of api.handlers.get(name) ?? []) {
      const result = await handler(current as never, context);

      results.push(result);

      if (name === 'context' && typeof result === 'object' && result !== null) {
        Object.assign(current, result);
      }
    }

    return { results, event: current };
  };

  const call = async (toolName: string, path: string, parentToolCallId?: string) =>
    (await emit('tool_call', { toolName, input: { path }, parentToolCallId })).results;

  const prompt = async () => {
    const { event } = await emit('before_agent_start', {
      systemPromptOptions: { appendSystemPrompt: '', selectedTools: ['read', 'edit', 'write'] },
    });

    const options = event['systemPromptOptions'] as { appendSystemPrompt: string };

    return options.appendSystemPrompt;
  };

  const request = async (messages: unknown[] = []) => (await emit('context', { messages })).event;

  await emit('session_start', { reason: 'startup' });

  return {
    api,
    appendEntry,
    sessionManager,
    idle,
    notify,
    context,
    directory,
    emit,
    call,
    prompt,
    request,
  };
};

const delivered = (customType: string, content: string) => ({
  customType,
  content,
  display: false,
});

for (const { language, label, customType, path, command } of cases) {
  const rules = bundledRules(language);
  const ruleMessage = { role: 'custom', customType, content: rules };

  it(`delivers ${label} rules after the first read without blocking it`, async ({
    onTestFinished,
  }) => {
    const fixture = await setup(onTestFinished);

    await fixture.request();

    expect(await fixture.call('read', path)).not.toContainEqual(
      expect.objectContaining({ block: true }),
    );

    expect(fixture.api.sendMessage).toHaveBeenCalledExactlyOnceWith(delivered(customType, rules), {
      deliverAs: 'steer',
    });

    expect(fixture.appendEntry).toHaveBeenCalledExactlyOnceWith(customType, { version: 1 });

    await fixture.call('read', path);
    expect(fixture.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it(`blocks a ${label} write until a model request sees the rules`, async ({ onTestFinished }) => {
    const fixture = await setup(onTestFinished);

    await fixture.request();
    const first = await fixture.call('write', path);
    const sibling = await fixture.call('edit', path, 'codemode-call');
    const reason: unknown = expect.stringMatching(/loaded.*reconsider/isu);

    expect(first).toEqual([expect.objectContaining({ block: true, reason })]);
    expect(sibling).toEqual(first);
    expect(fixture.appendEntry).toHaveBeenCalledTimes(1);
    expect(fixture.api.sendMessage).toHaveBeenCalledTimes(1);

    await fixture.request([ruleMessage]);
    expect(await fixture.call('write', path)).toEqual([undefined]);
  });

  it(`appends ${label} rules to the next run after resume from a saved entry`, async ({
    onTestFinished,
  }) => {
    const fixture = await setup(onTestFinished);

    fixture.sessionManager.appendCustomEntry(customType, { version: 1 });
    await fixture.emit('session_start', { reason: 'resume' });

    expect(await fixture.prompt()).toBe(rules);
    await fixture.request();
    expect(await fixture.call('write', path)).toEqual([undefined]);
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`sends ${label} rules again after compaction during the activation run`, async ({
    onTestFinished,
  }) => {
    const fixture = await setup(onTestFinished);

    await fixture.prompt();
    await fixture.call('read', path);
    fixture.api.sendMessage.mockClear();
    await fixture.emit('session_compact');

    expect(fixture.api.sendMessage).toHaveBeenCalledExactlyOnceWith(delivered(customType, rules), {
      deliverAs: 'steer',
    });
  });

  it(`does not resend ${label} rules after compaction when a run already carries them`, async ({
    onTestFinished,
  }) => {
    const fixture = await setup(onTestFinished);

    await fixture.call('read', path);
    await fixture.prompt();
    fixture.api.sendMessage.mockClear();
    await fixture.emit('session_compact');
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`does not send a ${label} compaction message while idle or inactive`, async ({
    onTestFinished,
  }) => {
    const fixture = await setup(onTestFinished);

    await fixture.emit('session_compact');
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
    await fixture.call('read', path);
    fixture.idle.mockReturnValue(true);
    fixture.api.sendMessage.mockClear();
    await fixture.emit('session_compact');
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`rebuilds ${label} activation when moving to another branch`, async ({ onTestFinished }) => {
    const fixture = await setup(onTestFinished);

    await fixture.call('read', path);
    expect(await fixture.prompt()).toBe(rules);
    fixture.sessionManager.resetLeaf();
    await fixture.emit('session_tree');
    expect(await fixture.prompt()).toBe('');
  });

  it.for([true, false])(
    `activates ${label} rules with the command and idle state %s`,
    async (idle, { onTestFinished }) => {
      const fixture = await setup(onTestFinished);

      fixture.idle.mockReturnValue(idle);
      const registered = fixture.api.commands.get(command);

      expect(registered).toBeDefined();
      await registered?.handler('', fixture.context as ExtensionCommandContext);
      expect(fixture.appendEntry).toHaveBeenCalledExactlyOnceWith(customType, { version: 1 });
      expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(`${label} rules are active.`, 'info');
      const messageCount = idle ? 0 : 1;

      expect(fixture.api.sendMessage).toHaveBeenCalledTimes(messageCount);
      expect(await fixture.prompt()).toBe(rules);
    },
  );

  it.for([
    { kind: 'newer', data: { version: 2 }, notice: /newer version 2.*restart/iu },
    { kind: 'malformed', data: { version: '1' }, notice: /malformed/iu },
  ])(
    `reports $kind ${label} activation evidence without activating`,
    async ({ data, notice }, { onTestFinished }) => {
      const fixture = await setup(onTestFinished);

      fixture.sessionManager.appendCustomEntry(customType, data);
      const branch = fixture.sessionManager.getBranch();

      await fixture.emit('session_start', { reason: 'resume' });

      expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(label),
        'warning',
      );

      expect(fixture.notify).toHaveBeenCalledWith(expect.stringMatching(notice), 'warning');
      expect(await fixture.prompt()).toBe('');
      expect(fixture.sessionManager.getBranch()).toEqual(branch);
      expect(fixture.appendEntry).not.toHaveBeenCalled();
      expect(fixture.api.sendMessage).not.toHaveBeenCalled();
    },
  );

  it(`leaves ${label} first-access rules off in a stomme project`, async ({ onTestFinished }) => {
    const fixture = await setup(onTestFinished);

    await writeStommeProject(fixture.directory, { language });
    fixture.sessionManager.appendCustomEntry(customType, { version: 1 });
    await fixture.emit('session_start', { reason: 'resume' });
    fixture.api.sendMessage.mockClear();
    fixture.appendEntry.mockClear();

    expect(await fixture.prompt()).toBe('');
    await fixture.request();
    expect(await fixture.call('read', path)).toEqual([undefined]);
    expect(await fixture.call('write', path)).toEqual([undefined]);
    await fixture.emit('session_compact');
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`drops ${label} bundle rules when stomme.toml appears mid-session`, async ({
    onTestFinished,
  }) => {
    const fixture = await setup(onTestFinished);

    expect(await fixture.prompt()).toBe('');
    await fixture.call('read', path);
    const earlier = await fixture.request([ruleMessage]);

    expect(earlier['messages']).toEqual([ruleMessage]);

    await writeStommeProject(fixture.directory, { language });

    expect(await fixture.prompt()).toBe('');

    const kept = { role: 'user', content: 'Continue.' };
    const later = await fixture.request([ruleMessage, kept]);

    expect(later['messages']).toEqual([kept]);
  });

  it(`tells a stomme project that its ${label} guide already loads`, async ({ onTestFinished }) => {
    const fixture = await setup(onTestFinished);

    await writeStommeProject(fixture.directory, { language });
    await fixture.prompt();

    await fixture.api.commands
      .get(command)
      ?.handler('', fixture.context as ExtensionCommandContext);

    expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/project.*guide.*already loads/isu),
      'info',
    );

    expect(fixture.appendEntry).not.toHaveBeenCalled();
  });
}

it('does not treat an unrelated custom message as loaded rules', async ({ onTestFinished }) => {
  const fixture = await setup(onTestFinished);

  await fixture.request([{ role: 'custom', customType: 'other', content: 'text' }]);
  expect(await fixture.call('edit', 'main.ts')).toEqual([expect.objectContaining({ block: true })]);
});

it('keeps the other language off after one activates', async ({ onTestFinished }) => {
  const fixture = await setup(onTestFinished);

  await fixture.call('read', 'main.ts');
  await fixture.request([{ role: 'custom', customType: 'tau-typescript-rules', content: 'rules' }]);

  expect(await fixture.call('write', 'src/lib.rs')).toEqual([
    expect.objectContaining({ block: true }),
  ]);

  expect(fixture.appendEntry).toHaveBeenCalledWith('tau-rust-rules', { version: 1 });
});

it('leaves sessions without TypeScript or Rust files without rules or messages', async ({
  onTestFinished,
}) => {
  const fixture = await setup(onTestFinished);

  await fixture.call('read', 'README.md');
  await fixture.call('write', 'main.go');

  expect(await fixture.prompt()).toBe('');
  expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  expect(fixture.appendEntry).not.toHaveBeenCalled();
});
