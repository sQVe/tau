import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { isNestedControlCall, nestedControlCallReason } from '../../codemode/controlTools.js';
import type { Exec } from '../../command.js';
import {
  forgetReportedWarnings,
  readTauConfig,
  warnUnknownTopLevelKeys,
} from '../../config/config.js';
import { errorMessage } from '../../errors.js';
import { connect } from '../../hc/connect.js';
import { subscribeEvents } from '../../hc/events.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { appendSystemPrompt } from '../../instructions/systemPrompt.js';
import { isWorkerProcess } from '../../worker.js';
import { executeAnswer } from './answer.js';
import { answerParameters } from './answerParameters.js';
import { readBrowserLoginCommand } from './browserLogin.js';
import { capacityRefusalBlock, clearsCapacityRefusal } from './capacityRefusal.js';
import { createDeadlineWatchdog } from './deadlineWatchdog.js';
import type { DeadlineWatchdog } from './deadlineWatchdog.js';
import { createEventWatch } from './eventWatch.js';
import type { EventWatch } from './eventWatch.js';
import { executeFollowUp } from './followUp.js';
import { followUpParameters } from './followUpParameters.js';
import { Admission, executeLaunch } from './launch.js';
import type { LaunchRuntime } from './launch.js';
import { checkLaunchEnvironment } from './launchCheck.js';
import { launchParameters } from './launchParameters.js';
import { launchModels, requireTrustedProject } from './loadout.js';
import { delegationGuidelines } from './managerPrompt.js';
import { readProfileModels } from './profileModels.js';
import { listProfiles } from './profiles.js';
import type { ProfileSummary } from './profiles.js';
import { defaultWorkerCapacity, readWorkerCapacity } from './workerCapacityConfig.js';
import { createWorkerDelivery } from './workerDelivery.js';
import { workerModelLine } from './workerModels.js';
import { createWorkerScan } from './workerScan.js';
import type { WorkerScan, WorkerScanContext } from './workerScan.js';

interface CapacityRefusal {
  refuse: () => void;
}

const piExec =
  (pi: ExtensionAPI): Exec =>
  (command, commandArguments, options) =>
    pi.exec(command, commandArguments, options);

// An unreadable profile directory also fails every launch, which reports the read error.
const launchProfiles = (
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
): ProfileSummary[] => {
  try {
    return listProfiles(context.cwd, getAgentDir(), context.isProjectTrusted());
  } catch {
    return [];
  }
};

const profileText = (profiles: ProfileSummary[]): string =>
  profiles.length === 0
    ? 'unreadable, launch reports why'
    : profiles
        .map(({ name, description }) =>
          description === undefined ? name : `${name} (${description})`,
        )
        .join(', ');

// A broken config leaves the line out, and each launch reports the error.
const launchModelLine = (
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'scopedModels' | 'ui'>,
  profiles: ProfileSummary[],
): string[] => {
  try {
    const location = {
      cwd: context.cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    };

    const names = profiles.map(({ name }) => name);

    const line = workerModelLine(
      launchModels(context, location),
      names,
      readProfileModels(location, context.ui),
    );

    return line === undefined ? [] : [line];
  } catch {
    return [];
  }
};

// A broken login command leaves the command out, so the manager still sends browser work.
const browserLoginCommand = (
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'ui'>,
): string | undefined => {
  try {
    return readBrowserLoginCommand(
      {
        cwd: context.cwd,
        agentDirectory: getAgentDir(),
        projectTrusted: context.isProjectTrusted(),
      },
      context.ui,
    );
  } catch (error) {
    context.ui.notify(errorMessage(error), 'error');

    return undefined;
  }
};

// An invalid cap refuses every launch, so a bad setting cannot raise the real limit.
const launchCapacity = (context: ExtensionContext): number => {
  try {
    return readWorkerCapacity(
      {
        cwd: context.cwd,
        agentDirectory: getAgentDir(),
        projectTrusted: context.isProjectTrusted(),
      },
      context.ui,
    );
  } catch (error) {
    context.ui.notify(errorMessage(error), 'error');

    return 0;
  }
};

const warnUnknownConfigKeys = (context: ExtensionContext): void => {
  try {
    const { files } = readTauConfig({
      cwd: context.cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });

    warnUnknownTopLevelKeys(context.ui, files);
  } catch {
    // The feature readers report an unreadable config file.
  }
};

const startScan = (scan: WorkerScan, context: WorkerScanContext): void => {
  scan.scan(context).catch(() => undefined);
};

const registerLaunchTool = (
  runtime: LaunchRuntime,
  profiles: ProfileSummary[],
  scan: WorkerScan,
  modelLine: string[] = [],
): void => {
  runtime.pi.registerTool({
    name: 'subagent',
    exposure: 'model-only',
    label: 'Launch worker',
    description: [
      'Launch a Pi worker as an hc child. cwd must match this session.',
      `Profiles: ${profileText(profiles)}. model overrides the profile default as provider/id.`,
      ...modelLine,
      'Editing workers require acceptance criteria. Brief them with, when it applies: outcome, scope and non-goals, entry files, decisions already made, baseline, and checks to run. Give the worktree; one editor per worktree. The deadline includes waits and cleanup.',
      'A worker event starts a new turn when a worker reports, asks a question, or stops. End your turn to wait; never sleep or poll.',
      'Answer a worker question with `subagent_answer`; report a refusal to the user.',
    ].join(' '),
    parameters: launchParameters,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      requireTrustedProject(context);

      const parentSession = context.sessionManager.getSessionFile();

      if (parentSession == null || parentSession === '') {
        throw new Error('Worker launch requires a saved parent Pi session.');
      }

      // The deadline covers the environment checks, so the worker's budget starts before them.
      const startedAt = { wall: Date.now(), monotonic: performance.now() };

      const resolved = await checkLaunchEnvironment(
        parameters,
        signal,
        context,
        piExec(runtime.pi),
      );

      const result = await executeLaunch(
        runtime,
        { parameters: resolved, startedAt, parentSession },
        signal,
        context,
      );

      startScan(scan, context);

      return result;
    },
  });
};

const registerFollowUpTool = (runtime: LaunchRuntime, scan: WorkerScan): void => {
  runtime.pi.registerTool({
    name: 'subagent_follow_up',
    exposure: 'model-only',
    label: 'Resume worker',
    description: [
      'Resume an ended worker from its saved Pi session in a new hc child, with a new assignment file and a fresh deadline.',
      'Pass the ended worker assignment ID, the new task, and acceptance criteria for editing workers.',
      'The follow-up is refused when the session file is missing or a running worker uses it. End your turn to wait; never sleep or poll.',
    ].join(' '),
    parameters: followUpParameters,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      requireTrustedProject(context);

      const parentSession = context.sessionManager.getSessionFile();

      if (parentSession == null || parentSession === '') {
        throw new Error('Worker follow-up requires a saved parent Pi session.');
      }

      const startedAt = { wall: Date.now(), monotonic: performance.now() };

      const result = await executeFollowUp(
        runtime,
        { parameters, startedAt, parentSession },
        signal,
        context,
      );

      startScan(scan, context);

      return result;
    },
  });
};

const registerAnswerTool = (runtime: LaunchRuntime): void => {
  runtime.pi.registerTool({
    name: 'subagent_answer',
    exposure: 'model-only',
    label: 'Answer worker',
    description: [
      "Answer a running worker's open question with the IDs from its question message.",
      'Tau saves the answer and queues it to the worker inbox. Queued is not a read receipt.',
    ].join(' '),
    parameters: answerParameters,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const parentSession = context.sessionManager.getSessionFile();

      if (parentSession == null || parentSession === '') {
        throw new Error('Answering a worker requires a saved parent Pi session.');
      }

      return executeAnswer(runtime, { parameters, parentSession, cwd: context.cwd }, signal);
    },
  });
};

export const registerCapacityRefusal = (pi: ExtensionAPI): CapacityRefusal => {
  if (isWorkerProcess()) {
    return { refuse: () => undefined };
  }

  let capacityRefused = false;

  pi.on('session_start', () => {
    capacityRefused = false;
  });

  pi.on('message_start', (event) => {
    if (clearsCapacityRefusal(event.message)) {
      capacityRefused = false;
    }
  });

  pi.on('tool_call', () => capacityRefusalBlock(capacityRefused));

  return {
    refuse: () => {
      capacityRefused = true;
    },
  };
};

export const registerDeadlineWatchdog = (pi: ExtensionAPI, watchdog: DeadlineWatchdog): void => {
  pi.on('session_shutdown', () => {
    watchdog.clear();
  });
};

export const registerWorkerScan = (
  pi: ExtensionAPI,
  scan: WorkerScan,
  events: EventWatch,
): void => {
  pi.on('session_shutdown', () => {
    scan.clear();
    events.stop();
  });

  pi.on('session_start', (_event, context) => {
    startScan(scan, context);
    events.start(context);
  });

  pi.on('session_compact', (_event, context) => {
    startScan(scan, context);
  });
};

export default function subagentsExtension(
  pi: ExtensionAPI,
  capacityRefusal: CapacityRefusal,
): void {
  if (isWorkerProcess()) {
    return;
  }

  const admission = new Admission();
  let guidelines = delegationGuidelines(undefined);

  const delegating = currentTerminalAddress() !== undefined;

  const hc: HcRuntime = {
    exec: piExec(pi),
    connect,
    cwd: process.cwd(),
  };

  const delivery = createWorkerDelivery(pi);
  const watchdog = createDeadlineWatchdog(hc, delivery);
  const scan = createWorkerScan(hc, delivery, watchdog);
  const events = createEventWatch(subscribeEvents, scan);

  const launchRuntime = (capacity: number): LaunchRuntime => ({
    pi,
    hc,
    capacity,
    admission,
    agentDirectory: getAgentDir(),
    // oxlint-disable-next-line node/no-process-env -- the worker keeps the manager's shell setup.
    processEnvironment: process.env,
    refuseCapacity: capacityRefusal.refuse,
  });

  pi.on('before_agent_start', (event) => {
    if (delegating && event.systemPromptOptions.selectedTools.includes('subagent')) {
      appendSystemPrompt(event, guidelines.map((guideline) => `- ${guideline}`).join('\n'));
    }
  });

  pi.on('session_start', (_event, context) => {
    forgetReportedWarnings(context.ui);
    warnUnknownConfigKeys(context);

    const profiles = launchProfiles(context);

    const capacity = launchCapacity(context);

    const runtime = launchRuntime(capacity);

    registerLaunchTool(runtime, profiles, scan, launchModelLine(context, profiles));
    registerFollowUpTool(runtime, scan);
    registerAnswerTool(runtime);

    if (delegating) {
      guidelines = delegationGuidelines(browserLoginCommand(context));
    }
  });

  registerDeadlineWatchdog(pi, watchdog);
  registerWorkerScan(pi, scan, events);

  pi.on('tool_call', (event) => {
    if (isNestedControlCall(event)) {
      return { block: true, reason: nestedControlCallReason };
    }

    return undefined;
  });

  const fallbackRuntime = launchRuntime(defaultWorkerCapacity);

  registerLaunchTool(
    fallbackRuntime,
    launchProfiles({ cwd: process.cwd(), isProjectTrusted: () => false }),
    scan,
  );

  registerFollowUpTool(fallbackRuntime, scan);
  registerAnswerTool(fallbackRuntime);
}
