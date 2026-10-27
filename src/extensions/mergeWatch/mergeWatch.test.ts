import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createExecFake, failedResult, succeededResult } from '../../../tests/execFake.js';
import type { ExecHandler, ExecResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import mergeWatchExtension from './mergeWatch.js';

type Key = 'resolve' | 'state' | 'checks';

const url = 'https://github.com/owner/repo/pull/7';
const minute = 60_000;
const hours = 60 * minute;

const stateOutput = (state: string, mergedAt: string | null = null) =>
  succeededResult(JSON.stringify({ state, mergedAt }));

const checksOutput = (checks: { name: string; bucket: string }[], code = 8): ExecResult => ({
  code,
  killed: false,
  stdout: JSON.stringify(checks.map((check) => ({ ...check, state: check.bucket }))),
  stderr: '',
});

const pending = checksOutput([{ name: 'test', bucket: 'pending' }]);
const open = stateOutput('OPEN');
const merged = stateOutput('MERGED', '2026-10-27T10:00:00Z');

const keyOf = (_command: string, commandArguments: readonly string[]): Key | undefined => {
  if (commandArguments[1] === 'checks') {
    return 'checks';
  }

  return commandArguments.includes('state,mergedAt') ? 'state' : 'resolve';
};

const setup = (options: { idle?: boolean } = {}) => {
  const handlers: Record<Key, ExecHandler> = {
    resolve: () => succeededResult(JSON.stringify({ url })),
    state: () => open,
    checks: () => pending,
  };

  const execFake = createExecFake<Key>({ keyOf, handlerFor: (key) => handlers[key] });
  const fake = fakeExtensionApi({ exec: execFake.exec });
  const idle = options.idle ?? true;

  const context = {
    cwd: '/repository',
    isIdle: () => idle,
    signal: idle ? undefined : new AbortController().signal,
  } as unknown as ExtensionContext;

  mergeWatchExtension(fake.pi);

  const emit = async (name: string, event: unknown) => {
    for (const handler of fake.handlers.get(name) ?? []) {
      await handler(event as never, context);
    }
  };

  const runBash = (command: string, isError = false) =>
    emit('tool_result', { toolName: 'bash', input: { command }, content: [], isError });

  const polls = () =>
    execFake.calls.filter((call) => keyOf('gh', call.commandArguments) === 'state');

  return { fake, handlers, execFake, emit, runBash, polls };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

it('starts a turn that says the pull request merged', async () => {
  const { fake, handlers, runBash } = setup();

  await runBash('gh pr merge --auto --squash');
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute - 1);

  expect(fake.sendMessage).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);

  expect(fake.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ customType: 'tau-merge-watch', display: true }),
    { triggerTurn: true },
  );

  expect(fake.sendMessage.mock.calls[0]?.[0].content).toContain(url);
});

it('starts a turn that names each failed required check and stops polling', async () => {
  const { fake, handlers, runBash, polls } = setup();

  await runBash('gh pr merge 7 --auto');

  handlers.checks = () =>
    checksOutput(
      [
        { name: 'test', bucket: 'fail' },
        { name: 'build', bucket: 'pass' },
        { name: 'lint', bucket: 'cancel' },
      ],
      1,
    );

  await vi.advanceTimersByTimeAsync(minute);
  await vi.advanceTimersByTimeAsync(5 * minute);

  const content = fake.sendMessage.mock.calls[0]?.[0].content;

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  expect(content).toContain('test');
  expect(content).toContain('lint');
  expect(content).not.toContain('build');
  expect(polls()).toHaveLength(1);
});

it('starts a turn that names the state of a pull request closed without merging', async () => {
  const { fake, handlers, runBash } = setup();

  await runBash('gh pr merge --auto');
  handlers.state = () => stateOutput('CLOSED');
  await vi.advanceTimersByTimeAsync(minute);

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  expect(fake.sendMessage.mock.calls[0]?.[0].content).toContain('CLOSED');
});

it('starts a turn at the deadline when no required checks are reported', async () => {
  const { fake, handlers, runBash, polls } = setup();

  await runBash('gh pr merge --auto');
  handlers.checks = () => failedResult("no required checks reported on the 'feature' branch");
  await vi.advanceTimersByTimeAsync(2 * hours - 1);

  expect(fake.sendMessage).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(hours);

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  expect(fake.sendMessage.mock.calls[0]?.[0].content).toContain('not merged yet');
  expect(polls()).toHaveLength(119);
});

it('starts a turn at the deadline and aborts a read that never finishes', async () => {
  const { fake, handlers, execFake, runBash } = setup();

  await runBash('gh pr merge --auto');
  handlers.state = () => Promise.withResolvers<ExecResult>().promise;
  await vi.advanceTimersByTimeAsync(2 * hours);

  const hungRead = execFake.calls.find((call) => keyOf('gh', call.commandArguments) === 'state');

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  expect(fake.sendMessage.mock.calls[0]?.[0].content).toContain('not merged yet');
  expect(hungRead?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('aborts a pending checks read at session shutdown', async () => {
  const { handlers, execFake, runBash, emit } = setup();

  await runBash('gh pr merge --auto');
  handlers.checks = () => Promise.withResolvers<ExecResult>().promise;
  await vi.advanceTimersByTimeAsync(minute);
  await emit('session_shutdown', { reason: 'quit' });

  const checksRead = execFake.calls.find((call) => keyOf('gh', call.commandArguments) === 'checks');

  expect(checksRead?.signal?.aborted).toBe(true);
});

it('retries a failed read on the next poll', async () => {
  const { fake, handlers, runBash, polls } = setup();

  await runBash('gh pr merge --auto');
  handlers.state = () => failedResult('HTTP 502');
  handlers.checks = () => failedResult('HTTP 502');
  await vi.advanceTimersByTimeAsync(minute);
  handlers.state = () => succeededResult('not json');
  handlers.checks = () => succeededResult('not json');
  await vi.advanceTimersByTimeAsync(minute);

  expect(fake.sendMessage).not.toHaveBeenCalled();

  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  expect(polls()).toHaveLength(3);
});

it('stops every watcher and timer at session shutdown', async () => {
  const { fake, handlers, runBash, emit, polls } = setup();

  await runBash('gh pr merge --auto');
  await vi.advanceTimersByTimeAsync(minute);
  await emit('session_shutdown', { reason: 'quit' });
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(3 * hours);

  expect(fake.sendMessage).not.toHaveBeenCalled();
  expect(polls()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('starts no watcher for a pull request resolved after session shutdown', async () => {
  const { fake, handlers, runBash, emit, polls } = setup();
  const resolved = Promise.withResolvers<ExecResult>();

  handlers.resolve = () => resolved.promise;
  await runBash('gh pr merge --auto');
  await emit('session_shutdown', { reason: 'quit' });
  resolved.resolve(succeededResult(JSON.stringify({ url })));
  await vi.advanceTimersByTimeAsync(3 * hours);

  expect(fake.sendMessage).not.toHaveBeenCalled();
  expect(polls()).toHaveLength(0);
});

it('keeps one watcher when auto-merge runs again on a watched pull request', async () => {
  const { fake, handlers, runBash, polls } = setup();

  await runBash('gh pr merge --auto');
  await runBash('gh pr merge 7 --auto --squash');
  await vi.advanceTimersByTimeAsync(minute);

  expect(polls()).toHaveLength(1);

  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
});

it('resolves the pull request argument and repository of the merge command', async () => {
  const { execFake, runBash } = setup();

  await runBash('gh pr merge 42 -R owner/repo --auto');

  expect(execFake.calls[0]?.commandArguments).toEqual([
    'pr',
    'view',
    '42',
    '--repo',
    'owner/repo',
    '--json',
    'url',
  ]);
});

it('reads the state of the watched pull request and its required checks', async () => {
  const { execFake, runBash } = setup();

  await runBash('gh pr merge --auto');
  await vi.advanceTimersByTimeAsync(minute);

  expect(execFake.calls.slice(1).map((call) => call.commandArguments)).toEqual([
    ['pr', 'view', url, '--json', 'state,mergedAt'],
    ['pr', 'checks', url, '--required', '--json', 'name,bucket,state'],
  ]);
});

it('keeps watching when gh pr checks fails with checks in its output', async () => {
  const { fake, handlers, runBash, polls } = setup();

  await runBash('gh pr merge --auto');
  handlers.checks = () => checksOutput([{ name: 'test', bucket: 'fail' }], 4);
  await vi.advanceTimersByTimeAsync(2 * minute);

  expect(fake.sendMessage).not.toHaveBeenCalled();
  expect(polls()).toHaveLength(2);
});

it('watches a pull request again after its watch ended', async () => {
  const { fake, handlers, runBash } = setup();

  await runBash('gh pr merge --auto');
  handlers.checks = () => checksOutput([{ name: 'test', bucket: 'fail' }], 1);
  await vi.advanceTimersByTimeAsync(minute);
  handlers.checks = () => pending;
  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);

  expect(fake.sendMessage).toHaveBeenCalledTimes(2);
});

it('watches nothing after a failed or plain merge', async () => {
  const { execFake, runBash, emit } = setup();

  await runBash('gh pr merge --auto', true);
  await runBash('gh pr merge --squash');

  await emit('tool_result', {
    toolName: 'read',
    input: { command: 'gh pr merge --auto' },
    content: [],
    isError: false,
  });

  await vi.advanceTimersByTimeAsync(hours);

  expect(execFake.calls).toEqual([]);
});

it('steers the turn into a running agent', async () => {
  const { fake, handlers, runBash } = setup({ idle: false });

  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);

  expect(fake.sendMessage).toHaveBeenCalledWith(expect.anything(), {
    deliverAs: 'steer',
    triggerTurn: true,
  });
});
