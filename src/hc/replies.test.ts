import { expect, it } from 'vitest';

import {
  HcError,
  matchParsedReply,
  parseCliError,
  parseCommandReply,
  parseJsonRpcReplies,
} from './replies.js';

const terminal = {
  address: 't7',
  state: 'live',
  labels: { role: 'worker' },
  argv: ['pi'],
  cwd: '/repository',
  created_ms: 1000,
  screen: 'exact',
  cols: 80,
  rows: 24,
  parent: 't1',
  exit_code: null,
  status: { state: 'working', app: 'pi' },
};

const nestedWait = {
  terminal: 't8',
  ended: true,
  reason: 'exit',
  turn: 1,
  children: [],
  exit_code: 0,
};

const matchLines = (lines: string[], id: number): unknown =>
  matchParsedReply('hc connect', parseJsonRpcReplies('hc connect', lines), id);

const successCases = [
  {
    name: 'the run reply',
    parse: () => parseCommandReply('hc run', 'run', JSON.stringify(terminal)),
    expected: terminal,
  },
  {
    name: 'the get reply',
    parse: () => parseCommandReply('hc get', 'get', JSON.stringify(terminal)),
    expected: terminal,
  },
  {
    name: 'the ls reply',
    parse: () =>
      parseCommandReply(
        'hc ls',
        'ls',
        JSON.stringify({ terminals: [{ address: 't7', state: 'live' }] }),
      ),
    expected: { terminals: [{ address: 't7', state: 'live' }] },
  },
  {
    name: 'the send reply',
    parse: () =>
      parseCommandReply(
        'hc send',
        'send',
        JSON.stringify({ turn: 2, started: true, status: 'working', wait: null }),
      ),
    expected: { turn: 2, started: true, status: 'working', wait: null },
  },
  {
    name: 'the wait reply',
    parse: () =>
      parseCommandReply(
        'hc wait',
        'wait',
        JSON.stringify({
          terminal: 't7',
          ended: true,
          reason: 'exit',
          turn: 3,
          children: [],
          exit_code: 0,
        }),
      ),
    expected: {
      terminal: 't7',
      ended: true,
      reason: 'exit',
      turn: 3,
      children: [],
      exit_code: 0,
    },
  },
  {
    name: 'the wait reply with a valid nested child',
    parse: () =>
      parseCommandReply(
        'hc wait',
        'wait',
        JSON.stringify({
          terminal: 't7',
          ended: false,
          reason: 'children',
          turn: 3,
          children: [nestedWait],
        }),
      ),
    expected: {
      terminal: 't7',
      ended: false,
      reason: 'children',
      turn: 3,
      children: [nestedWait],
    },
  },
  {
    name: 'the kill reply',
    parse: () => parseCommandReply('hc kill', 'kill', JSON.stringify(terminal)),
    expected: terminal,
  },
  {
    name: 'the rm reply',
    parse: () => parseCommandReply('hc rm', 'rm', JSON.stringify({ removed: 't7' })),
    expected: { removed: 't7' },
  },
  {
    name: 'the label reply',
    parse: () => parseCommandReply('hc label', 'label', JSON.stringify(terminal)),
    expected: terminal,
  },
  {
    name: 'a reply after an error for another id',
    parse: () =>
      matchLines(
        [
          JSON.stringify({
            jsonrpc: '2.0',
            id: 99,
            error: { code: -32000, message: 'other', data: { kind: 'other' } },
          }),
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { address: 't7', state: 'live' } }),
        ],
        2,
      ),
    expected: { address: 't7', state: 'live' },
  },
  {
    name: 'a missing reply id',
    parse: () =>
      matchLines([JSON.stringify({ jsonrpc: '2.0', id: 1, result: { generation: 1 } })], 2),
    expected: undefined,
  },
];

it.each(successCases)('parses $name', ({ parse, expected }) => {
  expect(parse()).toEqual(expected);
});

const errorCases = [
  {
    name: 'the CLI error shape',
    parse: () => {
      throw parseCliError(
        'hc get',
        JSON.stringify({
          error: { kind: 'not_found', message: 'no terminal', hint: 'check the address' },
        }),
        3,
      );
    },
    expectedError: {
      kind: 'not_found',
      exitCode: 3,
      message: 'no terminal',
      hint: 'check the address',
    },
  },
  {
    name: 'the JSON-RPC error shape',
    parse: () =>
      matchLines(
        [
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            error: {
              code: -32000,
              message: 'not_found',
              data: { kind: 'not_found', hint: 'gone' },
            },
          }),
        ],
        2,
      ),
    expectedError: { kind: 'not_found', message: 'not_found', hint: 'gone' },
  },
  {
    name: 'malformed JSON',
    parse: () => parseCommandReply('hc get', 'get', '{not json'),
    expectedError: { kind: 'malformed' },
  },
  {
    name: 'an unexpected shape',
    parse: () => parseCommandReply('hc get', 'get', JSON.stringify({ nope: true })),
    expectedError: { kind: 'unexpected' },
  },
  {
    name: 'a wait reply with an invalid nested child',
    parse: () =>
      parseCommandReply(
        'hc wait',
        'wait',
        JSON.stringify({
          terminal: 't7',
          ended: true,
          reason: 'children',
          turn: 3,
          children: [{ terminal: 't8', ended: 'yes' }],
        }),
      ),
    expectedError: { kind: 'unexpected' },
  },
  {
    name: 'a malformed trailing line',
    parse: () =>
      matchLines(
        [
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { generation: 1 } }),
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { address: 't7', state: 'live' } }),
          'not-json',
        ],
        1,
      ),
    expectedError: { kind: 'malformed' },
  },
  {
    name: 'output missing the reply id',
    parse: () => matchLines(['{"jsonrpc":"2.0","result":{"address":"t7"}}'], 2),
    expectedError: { kind: 'malformed' },
  },
];

it.each(errorCases)('rejects $name', ({ parse, expectedError }) => {
  let thrown: unknown;

  try {
    parse();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(HcError);
  expect(thrown).toMatchObject({ name: 'HcError', ...expectedError });
});
