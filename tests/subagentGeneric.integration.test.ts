import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { agentPromptArguments, WorkerController } from '../src/extensions/subagents/controller.js';
import { isolatedHerdr } from '../src/extensions/subagents/fixtures/isolatedHerdr.js';
import { fixtureGenericLoadout } from '../src/extensions/subagents/fixtures/loadout.js';
import { toolAvailable } from './toolAvailable.js';

const hasHerdr = toolAvailable('herdr');

it.runIf(hasHerdr)(
  'uses the real herdr transport for generic startup and positional prompts',
  async () => {
    const { root, client } = await isolatedHerdr();
    const parentSession = join(root, 'parent.jsonl');
    writeFileSync(
      parentSession,
      `${JSON.stringify({ type: 'session', version: 3, id: 'parent', cwd: root })}\n`,
    );
    const workspace = JSON.stringify(
      JSON.parse(await client(['workspace', 'create', '--cwd', root, '--no-focus'])),
    );
    const paneId = workspace.match(/"root_pane":\{[^}]*"pane_id":"([^"]+)"/)?.[1];

    if (!paneId) {
      throw new Error(`Missing isolated herdr root pane: ${workspace}`);
    }

    const controller = new WorkerController(join(root, 'records'), client);
    onTestFinished(() => {
      controller.close();
    });
    const started = await controller.launch({
      task: 'Exercise rejected generic startup.',
      loadout: fixtureGenericLoadout(root, 'notakind'),
      timeout: 10_000,
      parentSession,
      parentSessionId: 'parent',
      parentPane: paneId,
    });

    expect(started).toMatchObject({ outcome: 'failure', state: 'stopped', capacityHeld: false });

    const promptFailure = await client(
      agentPromptArguments('no-such-agent', '-x leading text\nsecond line'),
    ).catch((error: unknown) => {
      if (typeof error !== 'object' || error === null || !('stderr' in error)) {
        return '';
      }

      return typeof error.stderr === 'string' ? error.stderr : '';
    });
    expect(promptFailure).toContain('agent_not_found');
    expect(promptFailure).not.toContain('unknown option');
  },
);
