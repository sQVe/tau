import { expect, it } from 'vitest';

import { cancelOwnedWorker } from './cancellation.js';

it('requests active Pi abort before attempting editor shutdown without claiming it stopped', async () => {
  const calls: string[][] = [];
  const owned = {
    kind: 'pi' as const,
    paneId: 'owned',
    shellPid: 1,
    processId: process.pid,
    token: '/tmp/unique-session.jsonl',
  };
  const client = async (arguments_: string[]) => {
    calls.push(arguments_);
    if (arguments_[1] === 'get') {
      return JSON.stringify({
        result: { agent: { pane_id: 'owned', agent: 'pi', agent_session: { value: owned.token } } },
      });
    }
    if (arguments_[1] === 'process-info') {
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: 'owned',
            shell_pid: 1,
            foreground_process_group_id: process.pid,
            foreground_processes: [{ pid: process.pid, argv: ['pi', owned.token] }],
          },
        },
      });
    }
    throw new Error('Injected unavailable terminal input.');
  };
  const result = await cancelOwnedWorker(owned, 100, client, new AbortController().signal);

  expect(calls.at(-1)).toEqual(['agent', 'send-keys', 'owned', 'escape', 'ctrl+c', 'ctrl+d']);
  expect(result.cleanup).toBe('unconfirmed');
  expect(result.detail).toContain('manual cleanup');
});
