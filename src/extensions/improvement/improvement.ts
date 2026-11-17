import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { piExec } from '../../command.js';
import { readImprovementStatus } from '../../improvement/status.js';
import { runSweep } from '../../improvement/sweep.js';
import { stringEnum } from '../../schema.js';
import { isWorkerProcess } from '../../worker.js';
import { runRecord } from './recordAction.js';
import { createStatusRefresh } from './statusAction.js';
import { startSweep } from './sweepStart.js';

const parameters = Type.Object({
  action: stringEnum(['record', 'status']),
  summary: Type.Optional(Type.String()),
});

const description = `- record: correction. {id,path,outcome}
- status: {projectRoot,tasks,correctDue,coverage,sweep,skipped}`;

const readStatus = (cwd: string) =>
  readImprovementStatus({ cwd, agentDirectory: getAgentDir(), now: new Date() });

export default function improvementExtension(
  pi: ExtensionAPI,
  options: { runSweep?: typeof runSweep } = {},
): void {
  if (isWorkerProcess()) {
    return;
  }

  const refresh = createStatusRefresh(readStatus);

  pi.registerTool(
    defineTool({
      name: 'improvement',
      label: 'Improvement',
      description,
      promptSnippet: 'Record a user correction.',
      parameters,
      async execute(toolCallId, input, _signal, _onUpdate, context) {
        if (input.action === 'status') {
          const status = await readStatus(context.cwd);

          return { content: [{ type: 'text', text: JSON.stringify(status) }], details: status };
        }

        const details = await runRecord(toolCallId, input.summary, context);

        // oxlint-disable-next-line typescript/no-floating-promises -- refresh turns every failure into undefined, so it cannot reject.
        void refresh(context);

        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      },
    }),
  );

  const sweepRunner = options.runSweep ?? runSweep;

  pi.on('session_start', (_event, context) => {
    // oxlint-disable-next-line typescript/no-floating-promises -- refresh turns every failure into undefined, so it cannot reject.
    void refresh(context);

    // oxlint-disable-next-line typescript/no-floating-promises -- startSweep turns every failure into undefined, so the sweep cannot reject.
    void startSweep(
      { cwd: context.cwd, agentDirectory: getAgentDir(), exec: piExec(pi) },
      sweepRunner,
    ).then(() => refresh(context));
  });
}
