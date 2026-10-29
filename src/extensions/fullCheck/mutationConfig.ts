import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { readRepositoryArgv, withIgnoredNote } from '../../config/fullCheck.js';

const missingMessage = (ignored: string | undefined): string =>
  withIgnoredNote(
    `No mutation check is configured. Add mutation.argv to .pi/tau.json in the repository, such as {"mutation": {"argv": ["pnpm", "exec", "mutation"]}}.`,
    ignored,
  );

// Reads the mutation command from the repository file only, since the repository owns its script.
export const readMutationArgv = (location: ConfigLocation, ui: ConfigWarnings): string[] => {
  const { argv, ignored } = readRepositoryArgv(location, ui, 'mutation');

  if (argv === undefined) {
    throw new Error(missingMessage(ignored));
  }

  return argv;
};
