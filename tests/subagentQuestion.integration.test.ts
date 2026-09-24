import { it } from 'vitest';

import {
  canRunPiWorker,
  piWorkerTimeout,
  runPiWorkerScenario,
} from '../src/extensions/subagents/fixtures/piWorkerScenario.js';

it
  .runIf(canRunPiWorker)
  .each(['question completion', 'question cancellation', 'question timeout'] as const)(
  'runs real canonical Pi %s with Safety Net in isolated herdr',
  async (scenario) => {
    await runPiWorkerScenario(scenario);
  },
  piWorkerTimeout,
);
