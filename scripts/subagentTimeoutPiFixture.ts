import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createParentDeadline, runClient } from './subagentTimeout.ts';
import type { OwnedWorker } from './subagentTimeout.ts';

// Loaded only by the model-free probe, never by Tau's extension entry point.
const fixture = (pi: ExtensionAPI) => {
  const parent = new AbortController();
  let task: ReturnType<typeof createParentDeadline> | undefined;
  let first: ReturnType<ReturnType<typeof createParentDeadline>['watch']> | undefined;

  // Normal input stops before the agent loop. The probe uses only local commands and user bash.
  pi.on('input', () => ({ action: 'handled' }));
  pi.on('session_shutdown', () => {
    parent.abort();
  });
  pi.registerCommand('deadline-probe', {
    description: 'Run the isolated model-free deadline check.',
    handler: async (argument, context) => {
      if (argument === 'exit') {
        context.shutdown();
        return;
      }

      if (!task) {
        assert.equal(argument, 'arm');
        const value: unknown = JSON.parse(await readFile(join(context.cwd, 'owned.json'), 'utf8'));
        assert.ok(value && typeof value === 'object');
        assert.ok('kind' in value && (value.kind === 'process' || value.kind === 'pi'));
        assert.ok('paneId' in value && typeof value.paneId === 'string');
        assert.ok('shellPid' in value && typeof value.shellPid === 'number');
        assert.ok('processId' in value && typeof value.processId === 'number');
        assert.ok('token' in value && typeof value.token === 'string');
        const owned: OwnedWorker = {
          kind: value.kind,
          paneId: value.paneId,
          shellPid: value.shellPid,
          processId: value.processId,
          token: value.token,
        };
        task = createParentDeadline(
          owned,
          5000,
          2000,
          (arguments_, budget, signal) => runClient('herdr', arguments_, budget, signal),
          parent.signal,
        );
        first = task.watch();
        void first.then((result) => {
          writeFileSync(join(context.cwd, 'result.json'), JSON.stringify(result));
        });
      }

      assert.equal(task.watch(), first);
      writeFileSync(
        join(context.cwd, `${argument}.json`),
        JSON.stringify({ deadline: task.deadline, parentPid: process.pid }),
      );
      context.ui.notify(`deadline-probe ${argument}`);
    },
  });
};

export default fixture;
