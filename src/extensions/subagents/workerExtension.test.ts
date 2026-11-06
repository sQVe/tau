import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { nestedChangeCallReason, nestedControlCallReason } from '../../codemode/controlTools.js';
import { writeAssignment } from './assignment.js';
import type { Assignment, SavedReport } from './assignment.js';
import {
  assignmentFor,
  dispatch,
  sendStartMessage,
  setup,
} from './fixtures/workerExtensionHarness.js';
import { workerPrompt } from './profiles.js';
import { workerContinuation } from './workerStart.js';

it('stops the worker with a visible error when the assignment file is missing', async () => {
  const { context, pi, shutdown } = setup(join('/nonexistent', 'assignment.json'));

  await pi.handler('session_start')({}, context);

  expect(context.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('Missing assignment file'),
    'error',
  );

  expect(shutdown).toHaveBeenCalledOnce();
});

it('stops the worker with a visible error when the assignment file is malformed', async () => {
  const { assignmentPath, context, pi, shutdown } = setup();

  mkdirSync(dirname(assignmentPath), { recursive: true });
  writeFileSync(assignmentPath, '{ not json');

  await pi.handler('session_start')({}, context);

  expect(context.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('Malformed assignment'),
    'error',
  );

  expect(shutdown).toHaveBeenCalledOnce();
});

it('reads the assignment and activates its tools without sending a message at session start', async () => {
  const { activeTools, context, directory, loadout, pi, shutdown, tools } = setup();

  await writeAssignment(assignmentFor(directory));

  await pi.handler('session_start')({}, context);

  expect(context.ui.notify).not.toHaveBeenCalled();
  expect(shutdown).not.toHaveBeenCalled();
  expect(activeTools).toHaveBeenCalledWith(tools);
  expect(pi.sendUserMessage).not.toHaveBeenCalled();

  expect(loadout.model).toBe('faux/test');
});

const savedReport: SavedReport = {
  outcome: 'success',
  summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
  evidence: [],
};

const expectedStartResults = (assignment: Assignment) => ({
  task: { action: 'transform', text: workerPrompt(assignment) },
  continuation: { action: 'transform', text: workerContinuation },
  handled: { action: 'handled' },
});

const taskBranch = [{ type: 'message', message: { role: 'user', content: 'Task' } }];

const questionReplyBranch = [
  ...taskBranch,
  { type: 'message', message: { role: 'toolResult', toolName: 'subagent_question' } },
];

it.each([
  {
    name: 'gives a new worker the task prompt',
    branch: [],
    report: null,
    expected: 'task',
    shutdownCalled: false,
  },
  {
    name: 'gives a resumed worker the continuation',
    branch: taskBranch,
    report: null,
    expected: 'continuation',
    shutdownCalled: false,
  },
  {
    name: 'handles a resumed worker waiting for an answer without a run',
    branch: questionReplyBranch,
    report: null,
    expected: 'handled',
    shutdownCalled: false,
  },
  {
    name: 'handles a resumed worker with a saved report by shutting down without a run',
    branch: taskBranch,
    report: savedReport,
    expected: 'handled',
    shutdownCalled: true,
  },
] as const)('$name', async ({ branch, report, expected, shutdownCalled }) => {
  const { context, directory, pi, shutdown } = setup();
  const assignment = assignmentFor(directory);

  await writeAssignment({ ...assignment, report });

  Object.assign(context.sessionManager, { getBranch: () => branch });

  await pi.handler('session_start')({}, context);

  expect(await sendStartMessage(pi, context)).toEqual(expectedStartResults(assignment)[expected]);
  expect(shutdown).toHaveBeenCalledTimes(shutdownCalled ? 1 : 0);
  expect(pi.sendUserMessage).not.toHaveBeenCalled();
});

it('handles the start message without a run when startup fails', async () => {
  const { context, pi, shutdown } = setup(join('/nonexistent', 'assignment.json'));

  await pi.handler('session_start')({}, context);

  expect(await sendStartMessage(pi, context)).toEqual({ action: 'handled' });
  expect(shutdown).toHaveBeenCalledOnce();
});

it('passes unrelated input through unchanged', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));

  await pi.handler('session_start')({}, context);

  const result = await Promise.resolve(
    pi.handler('input')({ type: 'input', text: 'Use A.', source: 'rpc' }, context),
  );

  expect(result).toEqual({ action: 'continue' });
});

it('passes a second start message through unchanged', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));

  await pi.handler('session_start')({}, context);
  await sendStartMessage(pi, context);

  expect(await sendStartMessage(pi, context)).toEqual({ action: 'continue' });
});

it('keeps a reloaded worker waiting without a second task prompt', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));

  Object.assign(context.sessionManager, {
    getBranch: () => [
      { type: 'message', message: { role: 'user', content: 'Task' } },
      { type: 'message', message: { role: 'toolResult', toolName: 'subagent_question' } },
    ],
  });

  await pi.handler('session_start')({}, context);

  expect(pi.sendUserMessage).not.toHaveBeenCalled();
  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toBeUndefined();

  dispatch(pi, 'agent_settled', {}, context);

  expect(shutdown).not.toHaveBeenCalled();
});

it('shuts a reloaded worker down without a message when its assignment already has a report', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment({
    ...assignmentFor(directory),
    report: {
      outcome: 'success',
      summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
      evidence: [],
    },
  });

  Object.assign(context.sessionManager, {
    getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Task' } }],
  });

  await pi.handler('session_start')({}, context);

  expect(pi.sendUserMessage).not.toHaveBeenCalled();
  expect(shutdown).toHaveBeenCalledOnce();
});

it('reminds again for a report after the parent answers a question the reminded worker asked', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toMatchObject({
    continue: true,
  });

  const question = pi.tools.get('subagent_question');

  if (question === undefined) {
    throw new Error('The question tool was not registered.');
  }

  await question.execute(
    'question',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  pi.handler('message_start')(
    { type: 'message_start', message: { role: 'user', content: 'Use A.' } },
    context,
  );

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toMatchObject({
    continue: true,
  });
});

it('does not restart the report reminder when a non-user message starts', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toMatchObject({
    continue: true,
  });

  pi.handler('message_start')(
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    context,
  );

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toBeUndefined();
});

it('shuts the worker down after a settled report', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const tool = pi.tools.get('subagent_report');

  if (tool === undefined) {
    throw new Error('The report tool was not registered.');
  }

  Object.assign(context.sessionManager, {
    getBranch: () => [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall' }],
        },
      },
    ],
  });

  await tool.execute(
    'call',
    {
      outcome: 'success',
      summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
      evidence: [],
    },
    undefined,
    undefined,
    context,
  );

  dispatch(pi, 'agent_settled', {}, context);

  expect(shutdown).toHaveBeenCalledOnce();
});

it('keeps the worker running and skips the report reminder when its turn ends on a question', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const tool = pi.tools.get('subagent_question');

  if (tool === undefined) {
    throw new Error('The question tool was not registered.');
  }

  await tool.execute(
    'call',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toBeUndefined();

  dispatch(pi, 'agent_settled', {}, context);

  expect(shutdown).not.toHaveBeenCalled();
});

it('shuts the worker down when a report is saved after a question in the same run', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const question = pi.tools.get('subagent_question');
  const report = pi.tools.get('subagent_report');

  if (question === undefined || report === undefined) {
    throw new Error('The question and report tools must be registered.');
  }

  await question.execute(
    'question',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  await report.execute(
    'report',
    {
      outcome: 'success',
      summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
      evidence: [],
    },
    undefined,
    undefined,
    context,
  );

  dispatch(pi, 'agent_settled', {}, context);

  expect(shutdown).toHaveBeenCalledOnce();
});

it('reminds for a report after a reply is consumed while the turn streams', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const question = pi.tools.get('subagent_question');

  if (question === undefined) {
    throw new Error('The question tool was not registered.');
  }

  await question.execute(
    'question',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  pi.handler('message_start')(
    { type: 'message_start', message: { role: 'user', content: 'Use A.' } },
    context,
  );

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toMatchObject({
    continue: true,
  });
});

it('shuts the worker down when the turn that answers its question settles', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const tool = pi.tools.get('subagent_question');

  if (tool === undefined) {
    throw new Error('The question tool was not registered.');
  }

  await tool.execute(
    'call',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  pi.handler('message_start')(
    { type: 'message_start', message: { role: 'user', content: 'Use A.' } },
    context,
  );

  dispatch(pi, 'agent_start', {}, context);
  dispatch(pi, 'agent_settled', {}, context);

  expect(shutdown).toHaveBeenCalledOnce();
});

it('reminds once for a report and shares that state', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const first = pi.handler('agent_before_settle')({ entries: [] }, context);
  const second = pi.handler('agent_before_settle')({ entries: [] }, context);

  expect(first).toMatchObject({ continue: true });
  expect(second).toBeUndefined();
});

it('blocks a control tool called from a codemode script', () => {
  const { context, pi } = setup();

  const result = pi.handler('tool_call')(
    { toolName: 'subagent_report', toolCallId: 'call', parentToolCallId: 'script' },
    context,
  );

  expect(result).toEqual({ block: true, reason: nestedControlCallReason });
});

it('blocks a change tool called from a codemode script', () => {
  const { context, pi } = setup();

  const result = pi.handler('tool_call')(
    { toolName: 'edit', toolCallId: 'call', parentToolCallId: 'script', input: {} },
    context,
  );

  expect(result).toEqual({ block: true, reason: nestedChangeCallReason });
});

it('blocks a direct worker questionnaire', () => {
  const { context, pi } = setup();

  const result = pi.handler('tool_call')(
    { toolName: 'ask_user_question', toolCallId: 'call', input: {} },
    context,
  );

  expect(result).toMatchObject({ block: true });
});

it.each(['subagent_report', 'subagent_question'])(
  'blocks %s when it shares its turn with another tool call',
  (toolName) => {
    const { context, pi } = setup();

    Object.assign(context.sessionManager, {
      getBranch: () => [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall' }, { type: 'toolCall' }],
          },
        },
      ],
    });

    const result = pi.handler('tool_call')({ toolName, toolCallId: 'call', input: {} }, context);

    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain('alone');
  },
);
