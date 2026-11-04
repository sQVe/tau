import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseModelReference } from '../../config/models.js';
import type { SkillTools } from '../../skillTools.js';
import type { Loadout } from './types.js';
import { workerStartMessage } from './workerStart.js';
import { workerTools } from './workerTools.js';

export const workerArguments = (
  sessionFile: string,
  loadout: Loadout,
  extensionPackages: readonly { path: string }[],
  skillTools: SkillTools,
): string[] => {
  const model = parseModelReference(loadout.model);

  if (!model) {
    throw new Error('Pi workers need a provider/id model.');
  }

  return [
    '--approve',
    '--session',
    sessionFile,
    '--provider',
    model.provider,
    '--model',
    model.id,
    '--thinking',
    loadout.thinking,
    '--tools',
    workerTools(loadout, skillTools).join(','),
    '--no-skills',
    ...loadout.skills.flatMap((path) => ['--skill', path]),
    // Pi loads these command-line extensions before the saved configuration's, so the guard is active before CC Safety Net.
    '-e',
    fileURLToPath(new URL('./workerBashGuard.ts', import.meta.url)),
    '-e',
    fileURLToPath(new URL('./workerExtension.ts', import.meta.url)),
    ...extensionPackages.flatMap(({ path }) => ['-e', path]),
    workerStartMessage,
  ];
};

const piExecutable = (): string => {
  // oxlint-disable-next-line node/no-process-env -- Find pi as the user's shell would.
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, 'pi');

    try {
      if (isAbsolute(directory) && statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);

        return candidate;
      }
    } catch {
      // Try the next PATH entry.
    }
  }

  throw new Error('No pi executable found on PATH.');
};

export const workerCommand = (
  sessionFile: string,
  loadout: Loadout,
  extensionPackages: readonly { path: string }[],
  skillTools: SkillTools,
): string[] => [
  piExecutable(),
  ...workerArguments(sessionFile, loadout, extensionPackages, skillTools),
];

const isWorkingDirectoryVariable = (name: string): boolean => name === 'PWD' || name === 'OLDPWD';

const isTerminalVariable = (name: string): boolean => name === 'HC_TERMINAL_ID';

// hc finds its core from these two paths, and runs a terminal on top of the core's environment.
// Forwarding the manager's own copies would let a test reach the user's core. The rest of the
// manager's environment, including HOME and the other XDG settings, stays with the worker.
const isCorePathVariable = (name: string): boolean =>
  name === 'XDG_RUNTIME_DIR' || name === 'XDG_STATE_HOME';

const isManagerVariable = (name: string): boolean =>
  isWorkingDirectoryVariable(name) || isTerminalVariable(name) || isCorePathVariable(name);

export const workerEnvironment = (
  processEnvironment: NodeJS.ProcessEnv,
  agentDirectory: string,
): Record<string, string> => {
  const inherited = Object.entries(processEnvironment).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !isManagerVariable(entry[0]),
  );

  return {
    ...Object.fromEntries(inherited),
    TAU_ROLE: 'worker',
    PI_CODING_AGENT_DIR: agentDirectory,
  };
};
