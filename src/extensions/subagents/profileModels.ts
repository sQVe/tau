import { parseModelEntry } from '../../models/models.js';
import { isRecord, readUserOnlyKey } from '../../tauConfig.js';
import type { ConfigLocation } from '../../tauConfig.js';
import type { ProfileModels } from './workerModels.js';

// Entries for profiles that do not exist are kept, since a profile may exist only in one repository.
export const readProfileModels = (location: ConfigLocation): ProfileModels => {
  const user = readUserOnlyKey(location, 'profiles');

  if (user === undefined) {
    return new Map();
  }

  const { source, value: profiles } = user;

  if (!isRecord(profiles)) {
    throw new Error(
      `Invalid Tau config ${source}: profiles must be an object that maps profile names to {"model": "provider/model-id"}.`,
    );
  }

  return new Map(
    Object.entries(profiles).map(([name, entry]) => [
      name,
      parseModelEntry(source, `profiles.${name}`, entry),
    ]),
  );
};
