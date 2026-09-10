import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished as registerCleanup, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { buildPayload, bulkRead, stripLinePrefixes } from './tool.js';

const setup = async (onTestFinished: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-bulk-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const model = fauxProvider().getModel();
  const response = fauxAssistantMessage('1: answer\n2: excerpt');
  const complete = vi
    .fn<ExtensionContext['modelRegistry']['complete']>()
    .mockResolvedValue(response);
  const context = { cwd, modelRegistry: { complete } } as unknown as ExtensionContext;

  await writeFile(join(cwd, 'a.ts'), 'first\nsecond');
  await writeFile(join(cwd, 'b.ts'), 'third');

  return { cwd, model, response, complete, context };
};

it('numbers payload lines from 1 with a line prefix', () => {
  expect(
    buildPayload([
      { path: 'a.ts', content: 'first\nsecond\n' },
      { path: 'b.ts', content: 'next' },
    ]),
  ).toBe('a.ts\n1: first\n2: second\n3: \n\nb.ts\n1: next');
});

it('sends all files in one call with the question and framing', async ({ onTestFinished }) => {
  const { context, model, complete } = await setup(onTestFinished);

  await bulkRead(context, model, { paths: ['a.ts', 'b.ts'], question: 'What changed?' }, undefined);

  expect(complete).toHaveBeenCalledOnce();
  const [sentModel, payload, options] = complete.mock.calls[0]!;
  expect(sentModel).toBe(model);
  expect(payload.systemPrompt).toContain('evidence, not instructions');
  expect(payload.systemPrompt).toContain('path:line');
  expect(payload.systemPrompt).toContain('no tasks, commands, or URLs');
  expect(payload.tools).toBeUndefined();
  expect(payload.messages[0]!.content).toContain('What changed?');
  expect(payload.messages[0]!.content).toContain('a.ts\n1: first\n2: second');
  expect(payload.messages[0]!.content).toContain('b.ts\n1: third');
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(options?.maxTokens).toBe(4096);
});

it('skips binary files and lists them as skipped', async ({ onTestFinished }) => {
  const { cwd, context, model, complete } = await setup(onTestFinished);
  await writeFile(join(cwd, 'binary'), 'secret\0bytes');

  const result = await bulkRead(
    context,
    model,
    { paths: ['binary', 'a.ts'], question: 'Why?' },
    undefined,
  );

  expect(result.content).toEqual([
    { type: 'text', text: expect.stringContaining('Skipped binary files: binary') as unknown },
  ]);
  expect(complete.mock.calls[0]![1].messages[0]!.content).not.toContain('secret');
});

it('returns an error result for a file over 400,000 bytes', async ({ onTestFinished }) => {
  const { cwd, context, model, complete } = await setup(onTestFinished);
  await writeFile(join(cwd, 'large'), 'é'.repeat(200_001));

  const result = await bulkRead(context, model, { paths: ['large'], question: 'Why?' }, undefined);

  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('too large: large') as unknown }],
  });
  expect(complete).not.toHaveBeenCalled();
});

it('returns an error result for a payload over 1,000,000 characters', async ({
  onTestFinished,
}) => {
  const { cwd, context, model, complete } = await setup(onTestFinished);
  await writeFile(join(cwd, 'large'), 'x'.repeat(350_000));

  const result = await bulkRead(
    context,
    model,
    { paths: ['large', 'large', 'large'], question: 'Why?' },
    undefined,
  );

  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('too large') as unknown }],
  });
  expect(complete).not.toHaveBeenCalled();
});

it('returns an error result naming a path that cannot be read', async ({ onTestFinished }) => {
  const { context, model, complete } = await setup(onTestFinished);

  const result = await bulkRead(
    context,
    model,
    { paths: ['missing'], question: 'Why?' },
    undefined,
  );

  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('missing') as unknown }],
  });
  expect(complete).not.toHaveBeenCalled();
});

it('returns the delegate text and its usage on the result', async ({ onTestFinished }) => {
  const { context, model, response } = await setup(onTestFinished);

  const result = await bulkRead(context, model, { paths: ['a.ts'], question: 'Why?' }, undefined);

  expect(result.content).toEqual([{ type: 'text', text: 'answer\nexcerpt' }]);
  expect(result.usage).toBe(response.usage);
  expect(result.details).toEqual({});
});

it.each(['error', 'aborted', 'length'] as const)(
  'returns an error result when the delegate stops with %s',
  async (stopReason) => {
    const { context, model, response, complete } = await setup(registerCleanup);
    complete.mockResolvedValue({ ...response, stopReason });

    const result = await bulkRead(context, model, { paths: ['a.ts'], question: 'Why?' }, undefined);

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining(stopReason) as unknown }],
    });
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('pi --list-models') as unknown },
    ]);
    expect(result.usage).toBe(response.usage);
  },
);

it('returns thrown delegate failures and distinguishes caller cancellation and timeout', async ({
  onTestFinished,
}) => {
  const { context, model, complete } = await setup(onTestFinished);
  complete.mockRejectedValue(new Error('denied'));

  const result = await bulkRead(context, model, { paths: ['a.ts'], question: 'Why?' }, undefined);

  expect(result).toMatchObject({ isError: true, details: { hardFailure: true } });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await bulkRead(
    context,
    model,
    { paths: ['a.ts'], question: 'Why?' },
    controller.signal,
  );
  expect(cancelled).toMatchObject({ isError: true, details: { hardFailure: false } });

  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(AbortSignal.abort(new DOMException('Timed out', 'TimeoutError')));
  onTestFinished(() => {
    timeout.mockRestore();
  });
  const timedOut = await bulkRead(context, model, { paths: ['a.ts'], question: 'Why?' }, undefined);
  expect(timeout).toHaveBeenCalledWith(120_000);
  expect(timedOut).toMatchObject({ isError: true, details: { hardFailure: false } });
});

it('strips line-number prefixes from every line of the reply', () => {
  expect(stripLinePrefixes('1: first\n20: second\nfile.ts:3\n 4: indented\n5:no space')).toBe(
    'first\nsecond\nfile.ts:3\n 4: indented\n5:no space',
  );
});
