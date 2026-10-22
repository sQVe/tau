import { afterEach, expect, it, vi } from 'vitest';

import {
  findTerminal,
  herdrPaneId,
  herdrSocketPath,
  insideHerdr,
  requireObject,
  resolveTerminal,
  result,
  terminalLocation,
} from './herdr.js';
import type { TerminalCall } from './herdr.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const pane = { pane_id: 'new:pane', terminal_id: 'owned', workspace_id: 'new', tab_id: 'new:tab' };

it('resolves stable terminal identity across workspace-qualified pane changes', async () => {
  const call = vi
    .fn<TerminalCall>()
    .mockResolvedValue(JSON.stringify({ result: { panes: [pane] } }));

  await expect(resolveTerminal('owned', call)).resolves.toEqual({
    paneId: 'new:pane',
    terminalId: 'owned',
    workspaceId: 'new',
    tabId: 'new:tab',
  });

  expect(call).toHaveBeenCalledExactlyOnceWith(['pane', 'list']);
});

it('finds no terminal, without an error, when the owned terminal is absent', async () => {
  const other = { ...pane, pane_id: 'other:pane', terminal_id: 'other' };
  const listing = JSON.stringify({ result: { panes: [other] } });
  const call = vi.fn<TerminalCall>().mockResolvedValue(listing);

  await expect(findTerminal('owned', call)).resolves.toBeUndefined();
});

it.each([
  ['missing', []],
  ['duplicate terminal', [pane, { ...pane, pane_id: 'another' }]],
  ['duplicate pane', [pane, { ...pane, terminal_id: 'another' }]],
  ['missing identity', [{ ...pane, terminal_id: undefined }]],
  ['mismatched identity', [{ ...pane, terminal_id: 'replacement' }]],
] as const)(
  'refuses %s terminal identity without falling back to a cached pane',
  async (_scenario, panes) => {
    const call = vi.fn<TerminalCall>().mockResolvedValue(JSON.stringify({ result: { panes } }));

    await expect(resolveTerminal('owned', call)).rejects.toThrow(/identity|ownership|absent/);
    expect(call).toHaveBeenCalledTimes(1);
  },
);

it.each([null, [], 'text', 5, undefined])(
  'refuses %j where herdr must return an object',
  (value) => {
    expect(() => requireObject(value)).toThrow('Malformed herdr response.');
    expect(() => result(JSON.stringify({ result: value }))).toThrow('Malformed herdr response.');
  },
);

it('reads an object response', () => {
  expect(requireObject({ panes: [] })).toEqual({ panes: [] });
});

it.each(['pane_id', 'terminal_id', 'workspace_id', 'tab_id'])(
  'refuses a pane whose %s is empty, not a string, or missing',
  (field) => {
    for (const value of ['', 5, null, undefined]) {
      expect(() => terminalLocation({ ...pane, [field]: value })).toThrow(
        'Missing herdr identity.',
      );
    }
  },
);

const readerCases = [
  { name: 'HERDR_ENV', value: '1', read: insideHerdr, expected: true },
  { name: 'HERDR_ENV', value: '0', read: insideHerdr, expected: false },
  { name: 'HERDR_ENV', value: '', read: insideHerdr, expected: false },
  { name: 'HERDR_PANE_ID', value: 'w1:p1', read: herdrPaneId, expected: 'w1:p1' },
  { name: 'HERDR_PANE_ID', value: '', read: herdrPaneId, expected: undefined },
  {
    name: 'HERDR_SOCKET_PATH',
    value: '/run/herdr.sock',
    read: herdrSocketPath,
    expected: '/run/herdr.sock',
  },
  { name: 'HERDR_SOCKET_PATH', value: '', read: herdrSocketPath, expected: undefined },
];

it.each(readerCases)('reads $name as $expected when set to "$value"', (readerCase) => {
  vi.stubEnv(readerCase.name, readerCase.value);

  expect(readerCase.read()).toBe(readerCase.expected);
});

it.each([
  { name: 'HERDR_PANE_ID', read: herdrPaneId, expected: undefined },
  { name: 'HERDR_SOCKET_PATH', read: herdrSocketPath, expected: undefined },
  { name: 'HERDR_ENV', read: insideHerdr, expected: false },
])('reads $name as absent when unset', (readerCase) => {
  vi.stubEnv(readerCase.name, undefined);

  expect(readerCase.read()).toBe(readerCase.expected);
});
