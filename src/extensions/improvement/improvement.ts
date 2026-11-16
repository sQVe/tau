import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { piExec } from '../../command.js';
import { runSweep } from '../../improvement/sweep.js';
import { isWorkerProcess } from '../../worker.js';
import { runRecord } from './recordAction.js';
import { startSweep } from './sweepStart.js';

const parameters = Type.Object({
  action: Type.Literal('record'),
  summary: Type.Optional(Type.String({ description: 'record: one sentence.' })),
});

const description = '- record: save a user correction. {id,path,outcome}; existing: saved before.';

export default function improvementExtension(
  pi: ExtensionAPI,
  options: { runSweep?: typeof runSweep } = {},
): void {
  if (isWorkerProcess()) {
    return;
  }

  pi.registerTool(
    defineTool({
      name: 'improvement',
      label: 'Improvement',
      description,
      promptSnippet: 'Record a user correction.',
      parameters,
      async execute(toolCallId, input, _signal, _onUpdate, context) {
        const details = await runRecord(toolCallId, input.summary, context);

        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      },
    }),
  );

  const sweepRunner = options.runSweep ?? runSweep;

  pi.on('session_start', (_event, context) => {
    // oxlint-disable-next-line typescript/no-floating-promises -- startSweep turns every failure into undefined, so the sweep cannot reject.
    void startSweep(
      { cwd: context.cwd, agentDirectory: getAgentDir(), exec: piExec(pi) },
      sweepRunner,
    );
  });
}
