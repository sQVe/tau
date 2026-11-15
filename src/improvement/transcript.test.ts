import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseTranscript } from './transcript.ts';

const normal = readFileSync(
  new URL('./fixtures/withoutPublication.jsonl', import.meta.url),
  'utf8',
);

const header = JSON.stringify({ type: 'session', id: 's', timestamp: 't0', cwd: '/work/me-1' });

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

describe('parseTranscript', () => {
  it('reads the cwd and the tool calls of a normal transcript in order', () => {
    const transcript = parseTranscript(normal);

    expect(transcript.status).toBe('read');
    expect('cwd' in transcript && transcript.cwd).toBe('/home/sqve/code/personal/tau/me-1449');

    const calls = 'calls' in transcript ? transcript.calls : [];

    expect(calls.map((call) => [call.entryId, call.tool, call.viaCodemode])).toEqual([
      ['bc113404', 'full_check', false],
      ['ec7ff06b', 'code_review', false],
      ['10b3b158', 'subagent', false],
      ['4c7bc974', 'codemode', false],
      ['4c7bc974', 'pr_feedback', true],
      ['4c7bc974', 'pr_feedback', true],
    ]);

    expect(calls[0]).toEqual({
      entryId: 'bc113404',
      callId: 'toolu_012ZPNmAa9c77y8akATaLK2o',
      timestamp: '2026-11-15T06:03:47.501Z',
      tool: 'full_check',
      arguments: {},
      viaCodemode: false,
      result: { error: undefined, details: { passed: false, exitCode: 1 } },
    });

    expect(calls[4]).toEqual({
      entryId: '4c7bc974',
      callId: 'toolu_01MwZtURqsCCGAdgLWWgsE1N/1',
      timestamp: '2026-11-15T06:18:39.462Z',
      tool: 'pr_feedback',
      arguments: { action: 'read', repository: 'github.com/sQVe/tau', pr: 665 },
      viaCodemode: true,
      result: { error: undefined, details: undefined },
    });
  });

  it('keeps a call without a result and reads the text of an error result', () => {
    const transcript = parseTranscript(
      lines(
        header,
        toolCall('a', 'full_check'),
        toolCall('b', 'pr', { action: 'verify' }),
        toolResult('b', { isError: true, content: [{ type: 'text', text: 'no PR' }] }),
      ),
    );

    const calls = 'calls' in transcript ? transcript.calls : [];

    expect(calls.map((call) => [call.callId, call.result])).toEqual([
      ['a', undefined],
      ['b', { error: 'no PR', details: undefined }],
    ]);
  });

  it('reads the status of each nested codemode call', () => {
    const nested = [
      { name: 'full_check', args: '{}', status: 'error', error: 'locked' },
      { name: 'pr', args: '{"action":"evidence","review":"/very/long/pa...', status: 'ok' },
      { name: 'subagent', args: '{}', status: 'running' },
    ];

    const transcript = parseTranscript(
      lines(header, toolCall('a', 'codemode'), toolResult('a', { details: { calls: nested } })),
    );

    const calls = 'calls' in transcript ? transcript.calls.slice(1) : [];

    expect(calls.map((call) => [call.callId, call.tool, call.arguments, call.result])).toEqual([
      ['a/1', 'full_check', {}, { error: 'locked', details: undefined }],
      ['a/2', 'pr', undefined, { error: undefined, details: undefined }],
      ['a/3', 'subagent', {}, undefined],
    ]);
  });

  it('reports a missing transcript', () => {
    expect(parseTranscript(undefined)).toEqual({ status: 'missing' });
  });

  it('reports a transcript with malformed lines and keeps what it could read', () => {
    const transcript = parseTranscript(
      lines(
        header,
        '{not json',
        toolCall('a', 'full_check'),
        JSON.stringify({ type: 'message', message: { role: 'user' } }),
      ),
    );

    expect(transcript).toMatchObject({
      status: 'malformed',
      cwd: '/work/me-1',
      reason: '2 lines are malformed.',
    });

    expect('calls' in transcript && transcript.calls.map((call) => call.callId)).toEqual(['a']);
  });

  it('reports a transcript without a session header as malformed', () => {
    const transcript = parseTranscript(lines(toolCall('a', 'full_check')));

    expect(transcript).toMatchObject({
      status: 'malformed',
      cwd: undefined,
      reason: 'The first line is not a session header.',
    });
  });
});
