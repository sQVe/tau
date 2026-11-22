import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { piExec } from '../../command.js';
import { readImprovementStatus } from '../../improvement/status.js';
import { runSweep } from '../../improvement/sweep.js';
import { isWorkerProcess } from '../../role/role.js';
import { runCorrect } from './correctAction.js';
import type { CorrectResult } from './correctAction.js';
import { runHistory } from './historyAction.js';
import { runRecord } from './recordAction.js';
import type { RecordResult } from './recordAction.js';
import { runClass } from './recordClass.js';
import { runPass } from './recordPass.js';
import type { PassResult } from './recordPass.js';
import { parseRecordRequest, parameters } from './recordRequest.js';
import { createStatusRefresh } from './statusAction.js';
import { createSweepLifecycle } from './sweepStart.js';
import { createSweepState } from './sweepState.js';
import { runTask } from './taskAction.js';

const description = `- record: correction (summary) in session project; review (pullRequest, outcome), backlog (review, item, summary), decision (review, item, or class, plus choice), class (identity, level, summary, occurrences), each with projectRoot, in task project; pass in every project root that has an event. {id,path,outcome} or pass {id,paths,failed}; existing kept.
- correct: read cross-project evidence. classes adds each class (identity, level, summary, occurrences, reverted, qaMiss) and ranks at most 5. Without classes {events,measures,rejected,coverage,gaps}; with {classes,measures,coverage,gaps}.
- history: after classes, read reverts, reviews, and comments for projectRoots and pullRequests. {reverts,reviews,comments,coverage,gaps}; coverage: complete|partial|unknown.
- status: tasks to review, correct due, coverage, sweep. {projectRoot,tasks,correctDue,coverage,sweep,gaps}
- task: read a merged task's transcripts, coverage, projectRoot (pullRequest, worktree).`;

export default function improvementExtension(
  pi: ExtensionAPI,
  options: { runSweep?: typeof runSweep; exec?: Exec } = {},
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

        if (request.action === 'history') {
          const history = await runHistory(
            { exec: options.exec ?? piExec(pi), cwd: context.cwd, signal: context.signal },
            request,
          );

          return { content: [{ type: 'text', text: JSON.stringify(history) }], details: history };
        }

        let details: RecordResult | PassResult | CorrectResult;

        if (request.action === 'correct') {
          details = await runCorrect(getAgentDir(), context.cwd, request);
        } else if (request.kind === 'pass') {
          details = await runPass(toolCallId, context, getAgentDir());
        } else if (request.kind === 'class') {
          details = await runClass(toolCallId, request, context);
        } else if (request.kind === 'decision' && 'class' in request) {
          details = await runClass(toolCallId, request, context);
        } else {
          details = await runRecord(toolCallId, request, context);
        }

        // oxlint-disable-next-line typescript/no-floating-promises -- refresh turns every failure into undefined, so it cannot reject.
        void refresh(context);

        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      },
    }),
  );

  const sweepRunner = options.runSweep ?? runSweep;
  const lifecycle = createSweepLifecycle(sweepRunner);

  pi.on('session_start', (_event, context) => {
    // oxlint-disable-next-line typescript/no-floating-promises -- refresh turns every failure into undefined, so it cannot reject.
    void refresh(context);

    lifecycle.start(
      { cwd: context.cwd, agentDirectory: getAgentDir(), exec: piExec(pi) },
      (outcome) => {
        sweepState.record(outcome);

        return refresh(context);
      },
    );
  });

  pi.on('session_shutdown', async () => {
    await lifecycle.stop();
  });
}
