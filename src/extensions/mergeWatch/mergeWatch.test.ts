import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { failedResult, succeededResult } from '../../../tests/execFake.js';
import type { ExecResult } from '../../../tests/execFake.js';
import {
  autoMergeOff,
  autoMergeOn,
  checksOutput,
  hours,
  keyOf,
  merged,
  minute,
  pending,
  resolvedOutput,
  setup,
  stateOutput,
  url,
} from './fixtures/mergeWatchSetup.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

it('starts a turn that says the pull request merged', async () => {
  const { fake, handlers, runBash, nextDelivery } = setup();

  await runBash('gh pr merge --auto --squash');
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute - 1);

  expect(fake.sendMessage).not.toHaveBeenCalled();

  const delivered = nextDelivery();
  await vi.advanceTimersByTimeAsync(1);
  await delivered;

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
  const { fake, handlers, runBash, polls, nextDelivery } = setup();

  await runBash('gh pr merge --auto');
  handlers.state = () => failedResult('HTTP 502');
  handlers.checks = () => failedResult('HTTP 502');
  await vi.advanceTimersByTimeAsync(minute);
  handlers.state = () => succeededResult('not json');
  handlers.checks = () => succeededResult('not json');
  await vi.advanceTimersByTimeAsync(minute);

  expect(fake.sendMessage).not.toHaveBeenCalled();

  const delivered = nextDelivery();
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);
  await delivered;

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  expect(polls()).toHaveLength(3);
});

it('delivers nothing when the session shuts down during the merged pull request read', async () => {
  const { fake, handlers, runBash, emit } = setup();
  const mergedRead = Promise.withResolvers<ExecResult>();

  handlers.merged = () => mergedRead.promise;
  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);
  await emit('session_shutdown', { reason: 'quit' });

  mergedRead.resolve(failedResult('HTTP 502'));

  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  expect(fake.sendMessage).not.toHaveBeenCalled();
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
  resolved.resolve(autoMergeOn);
  await vi.advanceTimersByTimeAsync(3 * hours);

  expect(fake.sendMessage).not.toHaveBeenCalled();
  expect(polls()).toHaveLength(0);
});

it('aborts a resolve read that never finishes at the time limit', async () => {
  const { fake, handlers, execFake, runBash } = setup();

  handlers.resolve = () => Promise.withResolvers<ExecResult>().promise;
  await runBash('gh pr merge --auto');
  await vi.advanceTimersByTimeAsync(2 * hours - 1);

  expect(execFake.calls[0]?.signal?.aborted).toBe(false);

  await vi.advanceTimersByTimeAsync(1);

  expect(execFake.calls[0]?.signal?.aborted).toBe(true);
  expect(fake.sendMessage).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('aborts a pending resolve read at session shutdown', async () => {
  const { handlers, execFake, runBash, emit } = setup();

  handlers.resolve = () => Promise.withResolvers<ExecResult>().promise;
  await runBash('gh pr merge --auto');
  await emit('session_shutdown', { reason: 'quit' });

  expect(execFake.calls[0]?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps one watcher when auto-merge runs again on a watched pull request', async () => {
  const { fake, handlers, runBash, polls, nextDelivery } = setup();

  await runBash('gh pr merge --auto');
  await runBash('gh pr merge 7 --auto --squash');
  await vi.advanceTimersByTimeAsync(minute);

  expect(polls()).toHaveLength(1);

  const delivered = nextDelivery();
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);
  await delivered;

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
    'url,state,autoMergeRequest',
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
  const { fake, handlers, runBash, nextDelivery } = setup();

  await runBash('gh pr merge --auto');
  handlers.checks = () => checksOutput([{ name: 'test', bucket: 'fail' }], 1);
  await vi.advanceTimersByTimeAsync(minute);
  handlers.checks = () => pending;
  await runBash('gh pr merge --auto');

  const delivered = nextDelivery();
  handlers.state = () => merged;
  await vi.advanceTimersByTimeAsync(minute);
  await delivered;

  expect(fake.sendMessage).toHaveBeenCalledTimes(2);
});

it('watches the same pull request again after its merge message', async () => {
  const { fake, handlers, runBash, polls, nextDelivery } = setup();

  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  const first = nextDelivery();
  await vi.advanceTimersByTimeAsync(minute);
  await first;

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);

  await runBash('gh pr merge --auto');
  handlers.state = () => stateOutput('OPEN');
  await vi.advanceTimersByTimeAsync(minute);

  expect(polls()).toHaveLength(2);

  handlers.state = () => merged;
  const second = nextDelivery();
  await vi.advanceTimersByTimeAsync(minute);
  await second;

  expect(fake.sendMessage).toHaveBeenCalledTimes(2);
});

it('watches nothing after a merge that left auto-merge off, whatever the bash status', async () => {
  const { handlers, runBash, polls } = setup();

  handlers.resolve = () => autoMergeOff;
  await runBash('gh pr merge --auto; echo done');
  await vi.advanceTimersByTimeAsync(hours);

  expect(polls()).toHaveLength(0);
});

it('watches a pull request with auto-merge on when a later command failed', async () => {
  const { runBash, polls } = setup();

  await runBash('gh pr merge --auto; false', true);
  await vi.advanceTimersByTimeAsync(minute);

  expect(polls()).toHaveLength(1);
});

it('watches a pull request that merged before the resolve read', async () => {
  const { fake, handlers, runBash, nextDelivery } = setup();

  handlers.resolve = () => resolvedOutput(null, 'MERGED');
  handlers.state = () => merged;
  await runBash('gh pr merge --auto');
  const delivered = nextDelivery();
  await vi.advanceTimersByTimeAsync(minute);
  await delivered;

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
});

it('watches nothing after a plain merge or another tool', async () => {
  const { execFake, runBash, emit } = setup();

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
  const { fake, handlers, runBash, nextDelivery } = setup({ idle: false });

  await runBash('gh pr merge --auto');
  handlers.state = () => merged;
  const delivered = nextDelivery();
  await vi.advanceTimersByTimeAsync(minute);
  await delivered;

  expect(fake.sendMessage).toHaveBeenCalledWith(expect.anything(), {
    deliverAs: 'steer',
    triggerTurn: true,
  });
});
