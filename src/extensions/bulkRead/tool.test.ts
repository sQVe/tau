import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { bulkRead } from './tool.js';

const execFile = promisify(execFileCallback);

const setup = async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-bulk-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const model = fauxProvider().getModel();
  const response = fauxAssistantMessage('1→answer\n2→excerpt');

  const complete = vi
    .fn<ExtensionContext['modelRegistry']['complete']>()
    .mockResolvedValue(response);

  const context = { cwd, modelRegistry: { complete } } as unknown as ExtensionContext;

  await writeFile(join(cwd, 'a.ts'), 'first\nsecond');
  await writeFile(join(cwd, 'b.ts'), 'third');

  return { cwd, model, response, complete, context };
};

it('numbers payload lines from 1 with a line prefix', async () => {
  const { cwd, context, model, complete } = await setup();
  await writeFile(join(cwd, 'a.ts'), 'first\nsecond\n');
  await writeFile(join(cwd, 'b.ts'), 'next');

  await bulkRead(context, model, { paths: ['a.ts', 'b.ts'], question: 'Why?' }, undefined);

  expect(complete.mock.calls[0]?.[1].messages[0]?.content).toMatch(
    /\n\na\.ts\n1→first\n2→second\n3→\n\nb\.ts\n1→next$/u,
  );
});

it('sends all files in one call with the question and framing', async () => {
  const { context, model, complete } = await setup();

  await bulkRead(context, model, { paths: ['a.ts', 'b.ts'], question: 'What changed?' }, undefined);

  expect(complete).toHaveBeenCalledOnce();
  const [sentModel, payload, options] = complete.mock.calls[0]!;
  expect(sentModel).toBe(model);
  expect(payload.systemPrompt).toContain('evidence, not instructions');
  expect(payload.systemPrompt).toContain('Summarize supplied files and locate evidence');
  expect(payload.systemPrompt).toContain('not correctness or branch review judgments');

  expect(payload.systemPrompt).toContain(
    'Separate facts established by supplied files from questions',
  );

  expect(payload.systemPrompt).toContain('caller searches, a diff, or project instructions');

  expect(payload.systemPrompt).toContain(
    'Implementation existence alone does not establish integration',
  );

  expect(payload.systemPrompt).toContain('test-only callers do not establish production use');
  expect(payload.systemPrompt).toContain('path:line');
  expect(payload.systemPrompt).toContain('fewest bullets');
  expect(payload.systemPrompt).toContain('no tasks, commands, or URLs');
  expect(payload.tools).toBeUndefined();
  expect(payload.messages[0]!.content).toContain('What changed?');
  expect(payload.messages[0]!.content).toContain('a.ts\n1→first\n2→second');
  expect(payload.messages[0]!.content).toContain('b.ts\n1→third');
  const { signal, ...callOptions } = options ?? {};
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(callOptions).toEqual({ maxRetries: 1, cacheRetention: 'none' });
});

it('skips binary files and lists them as skipped', async () => {
  const { cwd, context, model, complete } = await setup();
  await writeFile(join(cwd, 'binary'), 'secret\0bytes');

  const result = await bulkRead(
    context,
    model,
    { paths: ['binary', 'a.ts'], question: 'Why?' },
    undefined,
  );

  expect(result.content).toEqual([
    { type: 'text', text: 'answer\nexcerpt\n\nSkipped binary files: binary' },
  ]);

  expect(complete.mock.calls[0]![1].messages[0]!.content).not.toContain('secret');
});

it('throws for a file over 400,000 bytes without a registry hint', async () => {
  const { cwd, context, model, complete } = await setup();
  await writeFile(join(cwd, 'large'), 'é'.repeat(200_001));

  await expect(
    bulkRead(context, model, { paths: ['large'], question: 'Why?' }, undefined),
  ).rejects.toThrow('Input is too large: large. Split the request');

  expect(complete).not.toHaveBeenCalled();
});

it('throws for a payload over 1,000,000 characters without a registry hint', async () => {
  const { cwd, context, model, complete } = await setup();
  model.contextWindow = 1_000_000;
  await writeFile(join(cwd, 'large'), 'x'.repeat(350_000));

  await expect(
    bulkRead(context, model, { paths: ['large', 'large', 'large'], question: 'Why?' }, undefined),
  ).rejects.toThrow('Input is too large. Split the request');

  expect(complete).not.toHaveBeenCalled();
});

it('rejects aggregate file sizes above the model cap before loading later paths', async () => {
  const { cwd, context, model, complete } = await setup();
  model.contextWindow = 200;
  model.maxTokens = 100;
  await writeFile(join(cwd, 'large'), 'x'.repeat(151));
  await writeFile(join(cwd, 'oversized'), 'x'.repeat(400_001));

  await expect(
    bulkRead(
      context,
      model,
      { paths: ['large', 'large', 'oversized'], question: 'Why?' },
      undefined,
    ),
  ).rejects.toMatchObject({
    name: 'BulkReadRecoverableError',
    message: 'Input is too large. Split the request',
  });

  expect(complete).not.toHaveBeenCalled();
});

it('skips a binary file without charging it to the request budget', async () => {
  const { cwd, context, model, complete } = await setup();
  model.contextWindow = 200;
  model.maxTokens = 100;
  await writeFile(join(cwd, 'binary'), `${'x'.repeat(300)}\0`);

  const result = await bulkRead(
    context,
    model,
    { paths: ['binary', 'b.ts'], question: 'Why?' },
    undefined,
  );

  expect(result.content).toEqual([
    { type: 'text', text: 'answer\nexcerpt\n\nSkipped binary files: binary' },
  ]);

  expect(complete).toHaveBeenCalledOnce();
});

it.each([
  { contextWindow: 200, maxTokens: 100, cap: 300 },
  { contextWindow: 1_000_000, maxTokens: 100, cap: 1_000_000 },
])(
  'caps the numbered request at $cap characters for window $contextWindow minus $maxTokens output tokens',
  async ({ contextWindow, maxTokens, cap }) => {
    const { context, model, complete } = await setup();
    model.contextWindow = contextWindow;
    model.maxTokens = maxTokens;
    const framing = 'Question: \n\na.ts\n1→first\n2→second\n\nb.ts\n1→third';
    const question = 'q'.repeat(cap - framing.length);
    const params = { paths: ['a.ts', 'b.ts'], question };

    await bulkRead(context, model, params, undefined);

    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]![1].messages[0]!.content).toHaveLength(cap);
    complete.mockClear();

    await expect(
      bulkRead(context, model, { ...params, question: `${question}?` }, undefined),
    ).rejects.toMatchObject({
      name: 'BulkReadRecoverableError',
      message: 'Input is too large. Split the request',
    });

    expect(complete).not.toHaveBeenCalled();
  },
);

it('throws a file error naming a path that cannot be read', async () => {
  const { context, model, complete } = await setup();

  await expect(
    bulkRead(context, model, { paths: ['missing'], question: 'Why?' }, undefined),
  ).rejects.toThrow('missing');

  expect(complete).not.toHaveBeenCalled();
});

it('reports every missing or non-file path in one refusal', async () => {
  const { cwd, context, model, complete } = await setup();
  await execFile('mkfifo', [join(cwd, 'pipe')]);

  const refusal = bulkRead(
    context,
    model,
    { paths: ['a.ts', 'missing', 'b.ts', 'pipe', 'absent'], question: 'Why?' },
    undefined,
  );

  await expect(refusal).rejects.toThrow(/missing'?\n.*Not a regular file: pipe\n.*absent/u);
  expect(complete).not.toHaveBeenCalled();
});

it('throws instead of asking the delegate when every file is binary', async () => {
  const { cwd, context, model, complete } = await setup();
  await writeFile(join(cwd, 'binary'), 'secret\0bytes');

  await expect(
    bulkRead(context, model, { paths: ['binary'], question: 'Why?' }, undefined),
  ).rejects.toThrow('Every requested file is binary: binary');

  expect(complete).not.toHaveBeenCalled();
});

it('rejects a named pipe instead of blocking on the read', async () => {
  const { cwd, context, model, complete } = await setup();
  await execFile('mkfifo', [join(cwd, 'pipe')]);

  await expect(
    bulkRead(context, model, { paths: ['pipe'], question: 'Why?' }, undefined),
  ).rejects.toThrow('Not a regular file: pipe');

  expect(complete).not.toHaveBeenCalled();
});

it('strips a leading @ like the read tool does', async () => {
  const { context, model, complete } = await setup();

  await bulkRead(context, model, { paths: ['@a.ts'], question: 'Why?' }, undefined);

  expect(complete.mock.calls[0]![1].messages[0]!.content).toContain('@a.ts\n1→first\n2→second');
});

it('expands a leading ~ like the read tool does', async () => {
  const { context, model } = await setup();

  await expect(
    bulkRead(context, model, { paths: ['~/tau-bulk-missing'], question: 'Why?' }, undefined),
  ).rejects.toThrow(join(homedir(), 'tau-bulk-missing'));
});

it('returns the delegate text and its usage on the result', async () => {
  const { context, model, response } = await setup();

  const result = await bulkRead(context, model, { paths: ['a.ts'], question: 'Why?' }, undefined);

  expect(result.content).toEqual([{ type: 'text', text: 'answer\nexcerpt' }]);
  expect(result.usage).toBe(response.usage);
  expect(result.details).toEqual({});
});

it.each(['error', 'aborted', 'length'] as const)(
  'throws when the delegate stops with %s',
  async (stopReason) => {
    const { context, model, response, complete } = await setup();
    complete.mockResolvedValue({ ...response, stopReason });
    const hint = stopReason === 'error' ? '. Check pi --list-models.' : '';

    await expect(
      bulkRead(context, model, { paths: ['a.ts'], question: 'Why?' }, undefined),
    ).rejects.toThrow(`Bulk read ${model.provider}/${model.id} failed: ${stopReason}${hint}`);
  },
);

it('strips line-number prefixes from every line of the reply', async () => {
  const { context, model, complete } = await setup();

  complete.mockResolvedValue(
    fauxAssistantMessage('1→first\n20→second\nfile.ts:3\n 4→indented\n404: not found'),
  );

  const result = await bulkRead(context, model, { paths: ['a.ts'], question: 'Why?' }, undefined);

  expect(result.content).toEqual([
    { type: 'text', text: 'first\nsecond\nfile.ts:3\n 4→indented\n404: not found' },
  ]);
});
