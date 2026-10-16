import { expect, it, vi } from 'vitest';

import { requireObject, resolveTerminal, result, terminalLocation } from './terminal.js';
import type { TerminalCall } from './terminal.js';

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
