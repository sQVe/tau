import {
  readTauConfig,
  requireKnownKey,
  userConfigPath,
  warnUnknownKeys,
} from '../../config/config.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { readArgv } from '../../config/fullCheck.js';
import { isRecord } from '../../schema.js';
import type { KnownKeys } from '../../schema.js';

const knownMutationKeys: KnownKeys = { argv: true };

const setsMutation = (value: unknown): boolean => {
  requireKnownKey('mutation');

  return isRecord(value) && Object.hasOwn(value, 'mutation');
};

const missingMessage = (ignored: string | undefined): string => {
  const base = `No mutation check is configured. Add mutation.argv to .pi/tau.json in the repository, such as {"mutation": {"argv": ["pnpm", "exec", "mutation"]}}.`;

  return ignored === undefined
    ? base
    : `${base} Tau ignored ${ignored} because the project is not trusted.`;
};

// Reads the mutation command from the repository file only, since the repository owns its script.
export const readMutationArgv = (location: ConfigLocation, ui: ConfigWarnings): string[] => {
  const { files, ignored } = readTauConfig(location);
  const userPath = userConfigPath(location.agentDirectory);
  const user = files.find((file) => file.source === userPath);

  if (user !== undefined && setsMutation(user.value)) {
    throw new Error(
      `Invalid Tau config ${userPath}: mutation belongs in .pi/tau.json in the repository. Move it there.`,
    );
  }

  const project = files.find((file) => file.source !== userPath && setsMutation(file.value));

  if (project === undefined || !isRecord(project.value)) {
    throw new Error(missingMessage(ignored));
  }

  const { source } = project;
  const { mutation } = project.value;

  if (!isRecord(mutation)) {
    throw new Error(
      `Invalid Tau config ${source}: mutation must be an object such as {"argv": ["pnpm", "exec", "mutation"]}.`,
    );
  }

  warnUnknownKeys(ui, source, mutation, knownMutationKeys, 'mutation');

  return readArgv(source, 'mutation.argv', mutation.argv);
};
