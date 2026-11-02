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
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { appendSystemPrompt } from '../../instructions/systemPrompt.js';
import { isWorkerProcess } from '../../worker.js';
import { readBrowserLoginCommand } from './browserLogin.js';
import { capacityRefusalBlock, clearsCapacityRefusal } from './capacityRefusal.js';
import { Admission, executeLaunch } from './launch.js';
import type { LaunchRuntime } from './launch.js';
import { checkLaunchEnvironment } from './launchCheck.js';
import { launchParameters } from './launchParameters.js';
import { launchModels, requireTrustedProject } from './loadout.js';
import { delegationGuidelines } from './managerPrompt.js';
import { readProfileModels } from './profileModels.js';
import { listProfiles } from './profiles.js';
import type { ProfileSummary } from './profiles.js';
import { createReportDelivery } from './reportDelivery.js';
import type { ReportDelivery } from './reportDelivery.js';
import { defaultWorkerCapacity, readWorkerCapacity } from './workerCapacityConfig.js';
import { workerModelLine } from './workerModels.js';

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

const registerLaunchTool = (
  runtime: LaunchRuntime,
  profiles: ProfileSummary[],
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
      'A worker note starts a new turn when a worker reports or stops. End your turn to wait; never sleep or poll.',
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

      return executeLaunch(
        runtime,
        { parameters: resolved, startedAt, parentSession },
        signal,
        context,
      );
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

export const registerReportDelivery = (pi: ExtensionAPI, delivery: ReportDelivery): void => {
  const deliverReports = (context: Parameters<ReportDelivery['deliver']>[0]): void => {
    delivery.deliver(context).catch((error: unknown) => {
      context.ui.notify(`Worker report delivery failed: ${errorMessage(error)}`, 'error');
    });
  };

  pi.on('input', (event, context) => {
    if (event.text.includes('[tau-report]')) {
      deliverReports(context);
    }
  });

  pi.on('session_start', (_event, context) => {
    deliverReports(context);
  });

  pi.on('session_compact', (_event, context) => {
    deliverReports(context);
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

  const delivery = createReportDelivery(pi, hc);

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

    registerLaunchTool(launchRuntime(capacity), profiles, launchModelLine(context, profiles));

    if (delegating) {
      guidelines = delegationGuidelines(browserLoginCommand(context));
    }
  });

  registerReportDelivery(pi, delivery);

  pi.on('tool_call', (event) => {
    if (isNestedControlCall(event)) {
      return { block: true, reason: nestedControlCallReason };
    }

    return undefined;
  });

  registerLaunchTool(
    launchRuntime(defaultWorkerCapacity),
    launchProfiles({ cwd: process.cwd(), isProjectTrusted: () => false }),
  );
}
