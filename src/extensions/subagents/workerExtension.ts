import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

import { registerCodemodeBudget } from '../../codemode/codemode.js';
import {
  isNestedChangeCall,
  isNestedControlCall,
  nestedChangeCallReason,
  nestedControlCallReason,
} from '../../codemode/controlTools.js';
import { codemodeGuidelines } from '../../codemode/guidelines.js';
import { connect } from '../../hc/connect.js';
import { currentTerminalAddress, readCurrentTerminal } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { instructionSetNames, readInstructionSet } from '../../instructions/instructions.js';
import { appendSystemPrompt, guidelineLines } from '../../instructions/systemPrompt.js';
import { skillTools } from '../../skillTools.js';
import { createWake } from '../../wake/wake.js';
import { isWorkerProcess } from '../../worker.js';
import { readAssignment } from './assignment.js';
import { checkWorkerRuntime } from './loadout.js';
import { workerInstructions, workerPrompt } from './profiles.js';
import { askParent, questionParameters } from './question.js';
import { reportParameters, reportToParent } from './report.js';
import type { ReportRefusalState, ReportTarget } from './report.js';
import { remindToReport } from './reportReminder.js';
import type { Loadout } from './types.js';
import { createWorkerDeadlineWarning } from './workerDeadlineWarning.js';
import type { WorkerDeadlineWarning } from './workerDeadlineWarning.js';
import { decideWorkerResume, decideWorkerStart } from './workerResume.js';
import type { WorkerStart } from './workerResume.js';
import { startPromptText } from './workerStart.js';
import { handleStartInput } from './workerStartInput.js';
import type { WorkerStartInput } from './workerStartInput.js';
import { workerTools } from './workerTools.js';

interface WorkerState {
  hc: HcRuntime;
  ready: Promise<void> | undefined;
  target: ReportTarget | undefined;
  refusal: ReportRefusalState;
  runError: string | undefined;
  questionAsked: boolean;
  startInput: WorkerStartInput;
}

const readLoadoutInstructionSets = (loadout: Loadout): Promise<string[]> =>
  Promise.all(
    instructionSetNames
      .filter((name) => loadout.instructionSets.includes(name))
      .map((name) => readInstructionSet(name)),
  );

const workerCodemodeGuidelines = (loadout: Loadout): string[] =>
  loadout.tools.includes('codemode') ? [guidelineLines(codemodeGuidelines)] : [];

export const workerSystemPrompt = async (loadout: Loadout): Promise<string> => {
  const instructionSets = await readLoadoutInstructionSets(loadout);

  return [
    workerInstructions(loadout),
    ...instructionSets,
    ...workerCodemodeGuidelines(loadout),
  ].join('\n\n');
};

const callsReportAlone = (
  assistant: ReturnType<ExtensionContext['sessionManager']['getBranch']>[number] | undefined,
): boolean =>
  assistant?.type === 'message' &&
  assistant.message.role === 'assistant' &&
  assistant.message.content.filter((block) => block.type === 'toolCall').length === 1;

const turnEndingToolNames: ReadonlySet<string> = new Set(['subagent_report', 'subagent_question']);

const handleToolCall = (
  event: ToolCallEvent,
  context: ExtensionContext,
): ToolCallEventResult | undefined => {
  if (isNestedControlCall(event)) {
    return { block: true, reason: nestedControlCallReason };
  }

  if (isNestedChangeCall(event)) {
    return { block: true, reason: nestedChangeCallReason };
  }

  if (event.toolName === 'ask_user_question') {
    return {
      block: true,
      reason:
        'Use subagent_question to ask the parent. Direct worker questionnaires are unavailable.',
    };
  }

  if (event.toolName === 'draft_review') {
    return {
      block: true,
      reason:
        'Direct worker reviews are unavailable. Finish the draft and report the draft path to the parent.',
    };
  }

  if (!turnEndingToolNames.has(event.toolName)) {
    return undefined;
  }

  const assistant = context.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant');

  if (!callsReportAlone(assistant)) {
    return { block: true, reason: `Call ${event.toolName} alone after all other tools finish.` };
  }

  return undefined;
};

const registerReportTool = (
  pi: ExtensionAPI,
  state: WorkerState,
  warning: WorkerDeadlineWarning,
): void => {
  pi.registerTool({
    name: 'subagent_report',
    exposure: 'model-only',
    label: 'Worker report',
    description: [
      'Submit the final report once. Put the report sections in summary; evidence holds references, not the Evidence section.',
      'Do not retry uncertain delivery.',
    ].join(' '),
    parameters: reportParameters,
    async execute(...argumentsList) {
      if (state.target === undefined) {
        throw new Error('Worker has no loaded assignment to report against.');
      }

      return reportToParent(state.target, argumentsList[1], warning);
    },
  });
};

const registerQuestionTool = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.registerTool({
    name: 'subagent_question',
    exposure: 'model-only',
    label: 'Worker question',
    description: [
      'Ask the parent one question that only the parent can answer.',
      'Your turn ends after the question is saved. Wait for the parent reply in a new message.',
    ].join(' '),
    parameters: questionParameters,
    async execute(...argumentsList) {
      if (state.target === undefined) {
        throw new Error('Worker has no loaded assignment to ask against.');
      }

      const result = await askParent(state.target, argumentsList[1]);

      state.questionAsked = true;

      return result;
    },
  });
};

const registerToolCallHandler = (pi: ExtensionAPI): void => {
  const checkCodemodeBudget = registerCodemodeBudget(pi);

  pi.on('tool_call', (event, context) => {
    const refusal = checkCodemodeBudget(event);

    return refusal ?? handleToolCall(event, context);
  });
};

const registerSystemPromptHandler = (pi: ExtensionAPI, state: WorkerState): void => {
  // Read once, so every turn gets the same text even if the checkout changes.
  let systemPrompt: Promise<string> | undefined;

  pi.on('before_agent_start', async (event) => {
    await state.ready;

    if (state.target !== undefined) {
      systemPrompt ??= workerSystemPrompt(state.target.assignment.loadout);
      appendSystemPrompt(event, await systemPrompt);
    }
  });
};

const readWorkerAssignment = async (
  state: WorkerState,
): Promise<Omit<ReportTarget, 'hc' | 'refusal'>> => {
  const terminalAddress = currentTerminalAddress();

  if (terminalAddress === undefined) {
    throw new Error('Worker has no HC_TERMINAL_ID; start it as an hc terminal.');
  }

  const terminal = await readCurrentTerminal(state.hc);

  if (terminal === undefined) {
    throw new Error(`hc get ${terminalAddress} returned nothing.`);
  }

  const assignmentPath = terminal.labels?.['tau.assignment'];

  if (assignmentPath === undefined || assignmentPath === '') {
    throw new Error('Worker terminal has no tau.assignment label.');
  }

  if (terminal.parent === undefined || terminal.parent === null || terminal.parent === '') {
    throw new Error('Worker terminal has no parent terminal.');
  }

  const assignment = await readAssignment(assignmentPath);

  if (assignment === undefined) {
    throw new Error(`Missing assignment file: ${assignmentPath}.`);
  }

  return {
    terminal: terminalAddress,
    assignmentPath,
    assignment,
  };
};

const runStartAction = (context: ExtensionContext, start: WorkerStart): void => {
  if (start === 'shutdown') {
    context.shutdown();
  }
};

const startWorker = async (
  pi: ExtensionAPI,
  state: WorkerState,
  context: ExtensionContext,
): Promise<void> => {
  try {
    const loaded = await readWorkerAssignment(state);

    state.target = { hc: state.hc, refusal: state.refusal, ...loaded };

    checkWorkerRuntime(
      loaded.assignment.loadout,
      pi,
      context,
      workerTools(loaded.assignment.loadout, skillTools),
    );

    const resume = decideWorkerResume(context.sessionManager.getBranch(), loaded.assignment);
    const hasReport = loaded.assignment.report !== null;

    state.questionAsked = resume.waitingForQuestion;

    const start = decideWorkerStart(resume, hasReport);

    state.startInput.startText = startPromptText(start, workerPrompt(loaded.assignment));

    runStartAction(context, start);
  } catch (error) {
    context.ui.notify(`Worker refused: ${String(error)}`, 'error');
    context.shutdown();
  }
};

const armDeadlineWarning = (
  warning: WorkerDeadlineWarning,
  context: ExtensionContext,
  state: WorkerState,
): void => {
  if (state.target === undefined || state.target.assignment.report !== null) {
    return;
  }

  warning.arm(context, state.target);
};

const registerStartInput = (
  pi: ExtensionAPI,
  state: WorkerState,
  warning: WorkerDeadlineWarning,
): void => {
  pi.on('input', async (event, context) => {
    const result = await handleStartInput(state.startInput, event.text, state.ready);

    if (result.action !== 'continue') {
      armDeadlineWarning(warning, context, state);
    }

    return result;
  });
};

const lastRunError = (event: AgentEndEvent): string | undefined => {
  const message = event.messages.findLast((entry) => entry.role === 'assistant');

  if (message?.role !== 'assistant') {
    return undefined;
  }

  if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
    return undefined;
  }

  return `Pi run ended with ${message.stopReason}: ${message.errorMessage ?? 'no error message'}`;
};

const registerReportReminder = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.on('agent_before_settle', (event) => {
    if (state.target === undefined) {
      return undefined;
    }

    return remindToReport(
      { target: state.target, runError: state.runError, questionAsked: state.questionAsked },
      event,
    );
  });
};

const registerAgentSettledHandler = (pi: ExtensionAPI, state: WorkerState): void => {
  pi.on('agent_settled', (_event, context) => {
    if (state.target === undefined) {
      return;
    }

    const waitingForReply = state.questionAsked && state.target.assignment.report === null;

    if (waitingForReply) {
      return;
    }

    context.shutdown();
  });
};

// The worker pane is bound to its saved native session, so /new, /resume, and /fork would orphan the task.
const registerSessionSwitchBlock = (pi: ExtensionAPI): void => {
  pi.on('session_before_switch', () => ({ cancel: true }));
  pi.on('session_before_fork', () => ({ cancel: true }));
};

export default function workerExtension(pi: ExtensionAPI): void {
  if (!isWorkerProcess()) {
    return;
  }

  const state: WorkerState = {
    hc: { exec: pi.exec.bind(pi), connect, cwd: process.cwd() },
    ready: undefined,
    target: undefined,
    refusal: { incompleteRefused: false, reminderSent: false, remindAfterRefusal: false },
    runError: undefined,
    questionAsked: false,
    startInput: { pending: true, startText: undefined },
  };

  const wake = createWake(pi);
  const deadlineWarning = createWorkerDeadlineWarning(wake);

  pi.on('session_start', (_event, context) => {
    state.ready = startWorker(pi, state, context);

    return state.ready;
  });

  pi.on('session_shutdown', () => {
    deadlineWarning.clear();
  });

  registerStartInput(pi, state, deadlineWarning);
  registerReportTool(pi, state, deadlineWarning);
  registerQuestionTool(pi, state);
  registerToolCallHandler(pi);
  registerSystemPromptHandler(pi, state);
  registerSessionSwitchBlock(pi);
  registerReportReminder(pi, state);
  registerAgentSettledHandler(pi, state);

  pi.on('message_start', (event) => {
    if (event.message.role === 'user') {
      state.questionAsked = false;
      state.refusal.reminderSent = false;
    }
  });

  pi.on('agent_end', (event) => {
    state.runError = lastRunError(event);
  });
}
