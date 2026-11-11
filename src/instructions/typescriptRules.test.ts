import { readFileSync } from 'node:fs';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { appendedSystemPrompt, fakeExtensionApi } from '../../tests/extensionApi.js';
import { registerTypeScriptRules } from './typescriptRules.js';

const rules = readFileSync(new URL('./typescript.md', import.meta.url), 'utf8');
const customType = 'tau-typescript-rules';

const setup = () => {
  const sessionManager = SessionManager.inMemory();

  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>((type, data) => {
    sessionManager.appendCustomEntry(type, data);
  });

  const api = fakeExtensionApi({ appendEntry });
  const idle = vi.fn<ExtensionContext['isIdle']>(() => false);
  const notify = vi.fn<ExtensionContext['ui']['notify']>();
  const context = { sessionManager, isIdle: idle, ui: { notify } } as unknown as ExtensionContext;

  registerTypeScriptRules(api.pi);

  const emit = (name: string, event: unknown = {}) => {
    const results = [];

    for (const handler of api.handlers.get(name) ?? []) {
      results.push(handler(event as never, context));
    }

    return results;
  };

  const call = (toolName: string, path: string, parentToolCallId?: string) =>
    emit('tool_call', { toolName, input: { path }, parentToolCallId });

  const prompt = () => appendedSystemPrompt(api.handlers, ['read', 'edit', 'write'], context);

  return { api, appendEntry, sessionManager, idle, notify, context, emit, call, prompt };
};

it('leaves non-TypeScript sessions without rules or messages', () => {
  const fixture = setup();

  fixture.emit('session_start', { reason: 'startup' });
  fixture.call('read', 'README.md');
  fixture.call('write', 'main.go');

  expect(fixture.prompt()).toBe('');
  expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  expect(fixture.appendEntry).not.toHaveBeenCalled();
});

it.for(['direct', 'nested'])(
  'delivers rules after the first %s read without changing read results',
  (access) => {
    const fixture = setup();
    const parent = access === 'nested' ? 'codemode-call' : undefined;

    fixture.emit('context', { messages: [] });

    expect(fixture.call('read', 'main.ts', parent)).not.toContainEqual(
      expect.objectContaining({ block: true }),
    );

    expect(fixture.api.sendMessage).toHaveBeenCalledExactlyOnceWith(
      { customType, content: rules, display: false },
      { deliverAs: 'steer' },
    );

    expect(fixture.appendEntry).toHaveBeenCalledExactlyOnceWith(customType, { version: 1 });
    expect(fixture.api.handlers.has('tool_result')).toBe(false);

    fixture.call('read', 'second.ts');
    expect(fixture.api.sendMessage).toHaveBeenCalledTimes(1);
  },
);

it.for(['edit', 'write'])(
  'blocks first and sibling %s calls until a model request sees the rules',
  (tool) => {
    const fixture = setup();

    fixture.emit('context', { messages: [] });
    const first = fixture.call(tool, 'main.ts');
    const sibling = fixture.call(tool, 'main.ts', 'codemode-call');

    const reason: unknown = expect.stringMatching(/loaded.*reconsider/isu);

    expect(first).toEqual([expect.objectContaining({ block: true, reason })]);
    expect(sibling).toEqual(first);
    expect(fixture.appendEntry).toHaveBeenCalledTimes(1);
    expect(fixture.api.sendMessage).toHaveBeenCalledTimes(1);

    fixture.emit('context', { messages: [{ role: 'custom', customType, content: rules }] });
    expect(fixture.call(tool, 'main.ts')).toEqual([undefined]);
  },
);

it('does not treat an unrelated custom message as loaded rules', () => {
  const fixture = setup();

  fixture.emit('context', { messages: [{ role: 'custom', customType: 'other', content: rules }] });
  expect(fixture.call('edit', 'main.ts')).toEqual([expect.objectContaining({ block: true })]);
});

it.for(['startup', 'reload', 'resume', 'fork', 'new'])(
  'rebuilds activation on session %s and appends rules on the next run',
  (reason) => {
    const fixture = setup();

    fixture.sessionManager.appendCustomEntry(customType, { version: 1 });
    fixture.emit('session_start', { reason });
    expect(fixture.prompt()).toBe(rules);
    fixture.emit('context', { messages: [] });
    expect(fixture.call('write', 'main.ts')).toEqual([undefined]);
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  },
);

it.for(['session_start', 'session_tree'])(
  'reports unreadable activation evidence on %s without losing valid activation',
  (event) => {
    const fixture = setup();

    fixture.sessionManager.appendCustomEntry(customType, { version: 2 });
    fixture.sessionManager.appendCustomEntry(customType, { version: '1' });
    fixture.sessionManager.appendCustomEntry(customType, { version: 1 });
    const branch = fixture.sessionManager.getBranch();

    fixture.emit(event);

    expect(fixture.notify).toHaveBeenCalledTimes(2);

    expect(fixture.notify).toHaveBeenCalledWith(
      expect.stringMatching(/newer.*restart/iu),
      'warning',
    );

    expect(fixture.notify).toHaveBeenCalledWith(
      expect.stringMatching(/malformed.*TypeScript/iu),
      'warning',
    );

    expect(fixture.prompt()).toBe(rules);
    expect(fixture.sessionManager.getBranch()).toEqual(branch);
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  },
);

it.for([
  { kind: 'newer', data: { version: 2 }, notice: /newer version 2.*restart/iu },
  { kind: 'malformed', data: { version: '1' }, notice: /malformed.*TypeScript/iu },
])('reports $kind activation evidence without activating', ({ data, notice }) => {
  const fixture = setup();

  fixture.sessionManager.appendCustomEntry(customType, data);
  const branch = fixture.sessionManager.getBranch();

  fixture.emit('session_start', { reason: 'resume' });

  expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(notice), 'warning');
  expect(fixture.prompt()).toBe('');
  expect(fixture.sessionManager.getBranch()).toEqual(branch);
  expect(fixture.appendEntry).not.toHaveBeenCalled();
  expect(fixture.api.sendMessage).not.toHaveBeenCalled();
});

it('rebuilds activation when moving to another branch', () => {
  const fixture = setup();

  fixture.call('read', 'main.ts');
  expect(fixture.prompt()).toBe(rules);
  fixture.sessionManager.resetLeaf();
  fixture.emit('session_tree');
  expect(fixture.prompt()).toBe('');
});

it('resets request state when a session starts', () => {
  const fixture = setup();

  fixture.emit('context', { messages: [{ role: 'custom', customType, content: rules }] });
  fixture.emit('session_start', { reason: 'new' });
  expect(fixture.call('edit', 'main.ts')).toEqual([expect.objectContaining({ block: true })]);
});

it.for(['session_start', 'session_tree'])(
  'drops the previous system prompt state on %s',
  (event) => {
    const fixture = setup();

    fixture.call('read', 'main.ts');
    fixture.prompt();
    fixture.emit('context', { messages: [] });
    fixture.sessionManager.resetLeaf();
    fixture.emit(event);
    fixture.emit('context', { messages: [] });

    expect(fixture.call('edit', 'main.ts')).toEqual([expect.objectContaining({ block: true })]);
  },
);

it('restores rules after compaction during the activation run', () => {
  const fixture = setup();

  fixture.prompt();
  fixture.call('read', 'main.ts');
  fixture.api.sendMessage.mockClear();
  fixture.emit('session_compact');

  expect(fixture.api.sendMessage).toHaveBeenCalledExactlyOnceWith(
    { customType, content: rules, display: false },
    { deliverAs: 'steer' },
  );
});

it('does not resend rules after compaction when the system prompt already carries them', () => {
  const fixture = setup();

  fixture.call('read', 'main.ts');
  fixture.prompt();
  fixture.api.sendMessage.mockClear();
  fixture.emit('session_compact');

  expect(fixture.api.sendMessage).not.toHaveBeenCalled();
});

it('does not send a compaction message while idle or inactive', () => {
  const fixture = setup();

  fixture.emit('session_compact');
  expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  fixture.call('read', 'main.ts');
  fixture.idle.mockReturnValue(true);
  fixture.api.sendMessage.mockClear();
  fixture.emit('session_compact');
  expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  expect(fixture.prompt()).toBe(rules);
});

it.for([true, false])('explicitly activates rules with idle state %s', async (idle) => {
  const fixture = setup();

  fixture.idle.mockReturnValue(idle);
  const command = fixture.api.commands.get('typescript-rules');

  expect(command).toBeDefined();
  await command?.handler('', fixture.context as ExtensionCommandContext);
  expect(fixture.appendEntry).toHaveBeenCalledExactlyOnceWith(customType, { version: 1 });
  expect(fixture.notify).toHaveBeenCalled();
  expect(fixture.api.sendMessage).toHaveBeenCalledTimes(idle ? 0 : 1);
  expect(fixture.prompt()).toBe(rules);
});
