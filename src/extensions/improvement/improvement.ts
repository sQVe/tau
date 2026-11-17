import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';

import { piExec } from '../../command.js';
import { readImprovementStatus } from '../../improvement/status.js';
import { runSweep } from '../../improvement/sweep.js';
import { isWorkerProcess } from '../../worker.js';
import { runRecord } from './recordAction.js';
import { parseRecordRequest, parameters } from './recordRequest.js';
import { createStatusRefresh } from './statusAction.js';
import { startSweep } from './sweepStart.js';
import { createSweepState } from './sweepState.js';
import { runTask } from './taskAction.js';

const description = `- record: correction (summary) in session project; review (pullRequest, outcome), backlog (review, item, summary), decision (review, item, choice), each with projectRoot, in task project. {id,path,outcome}; existing kept.
- status: tasks to review, correct due, coverage, sweep. {projectRoot,tasks,correctDue,coverage,sweep,gaps}
- task: read a merged task's transcripts, coverage, projectRoot (pullRequest, worktree).`;

export default function improvementExtension(
  pi: ExtensionAPI,
  options: { runSweep?: typeof runSweep } = {},
): void {
  if (isWorkerProcess()) {
    return;
  }

  const sweepState = createSweepState();

  const readStatus = (cwd: string) =>
    readImprovementStatus({
      cwd,
      agentDirectory: getAgentDir(),
      now: new Date(),
      sessionSweep: sweepState.latest(),
    });

  const refresh = createStatusRefresh(readStatus);

  pi.registerTool(
    defineTool({
      name: 'improvement',
      label: 'Improvement',
      description,
      promptSnippet: 'Record a correction or a task review result.',
      parameters,
      async execute(toolCallId, input, _signal, _onUpdate, context) {
        const request = parseRecordRequest(input);

        if (request.action === 'status') {
          const status = await readStatus(context.cwd);

          return { content: [{ type: 'text', text: JSON.stringify(status) }], details: status };
        }

        if (request.action === 'task') {
          const task = await runTask(piExec(pi), getAgentDir(), request, context);

          return { content: [{ type: 'text', text: JSON.stringify(task) }], details: task };
        }

        const details = await runRecord(toolCallId, input, context);

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

    // oxlint-disable-next-line typescript/no-floating-promises -- startSweep turns every failure into a failed outcome, so the sweep cannot reject.
    void startSweep(
      { cwd: context.cwd, agentDirectory: getAgentDir(), exec: piExec(pi) },
      sweepRunner,
    ).then((outcome) => {
      sweepState.record(outcome);

      return refresh(context);
    });
  });
}
