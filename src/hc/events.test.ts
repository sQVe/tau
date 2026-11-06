import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it, vi } from 'vitest';

import { subscribeEvents } from './events.js';
import type { EventSelector, HcEvent, SubscribeHandlers } from './events.js';

interface FakeChild {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  on: (event: string, listener: (...argumentsList: unknown[]) => void) => FakeChild;
  emit: (event: string, ...argumentsList: unknown[]) => boolean;
}

interface SubscribeMessage {
  method: string;
  params: unknown;
}

vi.mock(import('node:child_process'), async (importOriginal) => {
  const actual = await importOriginal();
  const spawnMock = vi.fn<typeof actual.spawn>(actual.spawn);

  return { ...actual, spawn: spawnMock as unknown as typeof actual.spawn };
});

const spawnMock = vi.mocked(spawn);

const createFakeChild = (): FakeChild => {
  // oxlint-disable-next-line unicorn/prefer-event-target -- A Node child process is an EventEmitter.
  const events = new EventEmitter();

  const child: FakeChild = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(),
    on: (event, listener) => {
      events.on(event, listener);

      return child;
    },
    emit: (event, ...argumentsList) => events.emit(event, ...argumentsList),
  };

  return child;
};

const createHandlers = () => {
  const ready: number[] = [];
  const events: HcEvent[] = [];
  const closes: string[] = [];

  const handlers: SubscribeHandlers = {
    onReady: () => ready.push(1),
    onEvent: (event) => events.push(event),
    onClose: (reason) => closes.push(reason),
  };

  return { handlers, ready, events, closes };
};

const subscribeLine = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  result: { seq: 0, terminals: [] },
})}\n`;

const helloLine = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: { generation: 1, version: '0.1.16', core: { id: 'c', name: 'n' } },
})}\n`;

const notification = (method: string, params: unknown): string =>
  `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;

afterEach(() => {
  vi.useRealTimers();
});

const subscribeMessages = (selector: EventSelector): SubscribeMessage[] => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers } = createHandlers();
  const write = vi.spyOn(child.stdin, 'write');

  subscribeEvents(selector, handlers);

  const written = write.mock.calls.map((call) => String(call[0])).join('');

  return written
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as SubscribeMessage);
};

const subscribeParams = (selector: EventSelector): unknown =>
  subscribeMessages(selector).find((message) => message.method === 'events.subscribe')?.params;

it('writes hello and events.subscribe with only the children filter', () => {
  expect(subscribeMessages({ childrenOf: 't-manager' })).toEqual([
    { jsonrpc: '2.0', id: 1, method: 'hello', params: { generation: 1 } },
    { jsonrpc: '2.0', id: 2, method: 'events.subscribe', params: { children_of: 't-manager' } },
  ]);
});

it('writes events.subscribe with only the terminal filter', () => {
  expect(subscribeParams({ terminal: 't-self' })).toEqual({ terminal: 't-self' });
});

it('reports ready after the subscribe reply and dispatches label and finished events', () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers, ready, events } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);

  child.stdout.emit('data', helloLine);
  child.stdout.emit('data', subscribeLine);
  child.stdout.emit('data', notification('event', { type: 'labels', terminal: 't-child' }));
  child.stdout.emit('data', notification('event', { type: 'finished', terminal: 't-child' }));

  expect(ready).toHaveLength(1);

  expect(events).toEqual([
    { method: 'event', type: 'labels' },
    { method: 'event', type: 'finished' },
  ]);
});

it('dispatches a heartbeat and a missed snapshot as notifications', () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers, events } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);

  child.stdout.emit('data', notification('heartbeat', { seq: 3 }));
  child.stdout.emit('data', notification('missed', { seq: 4 }));

  expect(events).toEqual([{ method: 'heartbeat' }, { method: 'missed' }]);
});

it('joins a split JSON line before dispatching it', () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers, events } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);

  const line = notification('event', { type: 'labels' });

  child.stdout.emit('data', line.slice(0, 10));
  child.stdout.emit('data', line.slice(10));

  expect(events).toEqual([{ method: 'event', type: 'labels' }]);
});

it('closes with the exit code when hc connect ends', () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers, closes } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);
  child.emit('close', 7, null);

  expect(closes).toEqual(['hc connect exited with code 7']);
});

it('closes when the subscribe reply has no result', () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers, ready, closes } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);
  child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 2 })}\n`);

  expect(ready).toHaveLength(0);
  expect(closes).toEqual(['hc connect printed reply 2 without a result']);
});

it('closes when a reply is an error', () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers, closes } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);

  child.stdout.emit(
    'data',
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'not_found' } })}\n`,
  );

  expect(closes).toEqual(['hc connect 2 failed: not_found']);
});

it('closes when a line is not JSON', () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers, closes } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);
  child.stdout.emit('data', 'not-json\n');

  expect(closes).toEqual(['hc connect printed a line that is not JSON']);
});

it('sends no signal when the child closes on its own', () => {
  vi.useFakeTimers();

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers, closes } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);
  child.emit('close', 7, null);

  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(closes).toEqual(['hc connect exited with code 7']);
});

it('escalates a failed child to SIGKILL when it ignores SIGTERM', () => {
  vi.useFakeTimers();

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);
  child.stdin.emit('error', new Error('write broke'));

  expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

  vi.advanceTimersByTime(5000);

  expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');

  child.emit('close', null, 'SIGKILL');
});

it('does not send SIGKILL when the child closes after SIGTERM', () => {
  vi.useFakeTimers();

  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers } = createHandlers();

  subscribeEvents({ childrenOf: 't-manager' }, handlers);
  child.stdin.emit('error', new Error('write broke'));
  child.emit('close', null, 'SIGTERM');

  vi.advanceTimersByTime(5000);

  expect(child.kill).toHaveBeenCalledTimes(1);
});

it('stops the child without a close report when the subscription is stopped', () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

  const { handlers, closes } = createHandlers();

  const subscription = subscribeEvents({ childrenOf: 't-manager' }, handlers);

  subscription.stop();
  child.emit('close', null, 'SIGTERM');

  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(closes).toEqual([]);
});
