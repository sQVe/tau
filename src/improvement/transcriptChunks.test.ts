import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { continueTranscript, finishTranscript, parseTranscript } from './transcript.ts';

const fixtureNames = readdirSync(new URL('./fixtures/', import.meta.url)).filter((name) =>
  name.endsWith('.jsonl'),
);

const newlineTerminated = (source: string) => source.slice(0, source.lastIndexOf('\n') + 1);

const linesOf = (source: string) => source.match(/[^\n]*\n/g) ?? [];

describe('continueTranscript', () => {
  it('reads a transcript in chunks as one parse', () => {
    for (const name of fixtureNames) {
      const source = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
      const terminated = newlineTerminated(source);

      let state = continueTranscript(undefined, '');

      for (const chunk of linesOf(terminated)) {
        // oxlint-disable-next-line unicorn/prefer-structured-clone typescript/no-unsafe-assignment -- The state must survive JSON.stringify and JSON.parse.
        state = JSON.parse(JSON.stringify(continueTranscript(state, chunk)));
      }

      expect(finishTranscript(state), name).toEqual(parseTranscript(terminated));
    }
  });
});

const header = JSON.stringify({ type: 'session', id: 's', timestamp: 't0', cwd: '/work' });

const message = (id: string, body: Record<string, unknown>) =>
  JSON.stringify({ type: 'message', id, timestamp: `${id}-time`, message: body });

const toolCall = (id: string, name: string, parameters: unknown = {}) =>
  message(`call-${id}`, {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: parameters }],
  });

const toolResult = (id: string, fields: Record<string, unknown>) =>
  message(`result-${id}`, { role: 'toolResult', toolCallId: id, ...fields });

const lines = (...entries: string[]) => `${entries.join('\n')}\n`;

const chunked = (...chunks: string[]) => {
  let state = continueTranscript(undefined, '');

  for (const chunk of chunks) {
    state = continueTranscript(state, chunk);
  }

  return finishTranscript(state);
};

describe('continueTranscript', () => {
  it('pairs a tool result with its call from an earlier chunk', () => {
    const source = lines(
      header,
      toolCall('a', 'full_check'),
      toolResult('a', { details: { passed: true } }),
    );

    const transcript = chunked(
      `${header}\n`,
      `${toolCall('a', 'full_check')}\n`,
      `${toolResult('a', { details: { passed: true } })}\n`,
    );

    expect(transcript).toEqual(parseTranscript(source));

    expect('calls' in transcript && transcript.calls[0]?.result).toEqual({
      details: { passed: true },
    });
  });

  it('expands codemode calls whose result arrives in a later chunk', () => {
    const nested = [
      { name: 'full_check', args: '{}', status: 'ok' },
      { name: 'pr', args: '{"action":"verify","pr":5}', status: 'error', error: 'no PR' },
    ];

    const source = lines(
      header,
      toolCall('a', 'codemode'),
      toolResult('a', { details: { calls: nested } }),
    );

    const transcript = chunked(
      `${header}\n`,
      `${toolCall('a', 'codemode')}\n`,
      `${toolResult('a', { details: { calls: nested } })}\n`,
    );

    expect(transcript).toEqual(parseTranscript(source));

    expect(
      'calls' in transcript &&
        transcript.calls.map((call) => [call.callId, call.tool, call.viaCodemode]),
    ).toEqual([
      ['a', 'codemode', false],
      ['a/1', 'full_check', true],
      ['a/2', 'pr', true],
    ]);
  });

  it('keeps the header after a malformed first line', () => {
    const transcript = chunked('{not json\n', `${header}\n`);

    expect(transcript).toMatchObject({
      status: 'malformed',
      cwd: '/work',
      reason: '1 lines are malformed.',
    });
  });

  it('overwrites a repeated result', () => {
    const source = lines(
      header,
      toolCall('a', 'full_check'),
      toolResult('a', { details: { passed: false } }),
      toolResult('a', { details: { passed: true } }),
    );

    const transcript = chunked(
      `${header}\n`,
      `${toolCall('a', 'full_check')}\n`,
      `${toolResult('a', { details: { passed: false } })}\n`,
      `${toolResult('a', { details: { passed: true } })}\n`,
    );

    expect(transcript).toEqual(parseTranscript(source));

    expect('calls' in transcript && transcript.calls[0]?.result).toEqual({
      details: { passed: true },
    });
  });

  it('replaces nested calls when a codemode result repeats', () => {
    const first = toolResult('a', {
      details: {
        calls: [{ name: 'pr', args: '{"action":"verify","pr":1}', status: 'ok' }],
      },
    });

    const second = toolResult('a', {
      details: {
        calls: [{ name: 'pr', args: '{"action":"verify","pr":2}', status: 'ok' }],
      },
    });

    const source = lines(header, toolCall('a', 'codemode'), first, second);

    const transcript = chunked(
      `${header}\n`,
      `${toolCall('a', 'codemode')}\n`,
      `${first}\n`,
      `${second}\n`,
    );

    expect(transcript).toEqual(parseTranscript(source));

    const nested = 'calls' in transcript ? transcript.calls.filter((call) => call.viaCodemode) : [];

    expect(nested.map((call) => call.arguments)).toEqual([{ action: 'verify', pr: 2 }]);
  });
});
