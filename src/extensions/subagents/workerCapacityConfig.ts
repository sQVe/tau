import { isRecord } from '../../isRecord.js';
import { readUserOnlyKey, warnUnknownKeys } from '../../tauConfig.js';
import type { ConfigLocation, ConfigWarnings } from '../../tauConfig.js';
import type { KnownKeys } from '../../unknownKeys.js';

export const defaultWorkerCapacity = 12;
const maximumWorkerCapacity = 256;

const knownSubagentsKeys: KnownKeys = { capacity: true };

const isInteger = (value: unknown): value is number => Number.isInteger(value);

// Reads how many live workers a parent controller runs at once. Only the user file may set
// `subagents`, since the limit protects the machine of the user.
export const readWorkerCapacity = (location: ConfigLocation, ui: ConfigWarnings): number => {
  const user = readUserOnlyKey(location, 'subagents');

  if (user === undefined) {
    return defaultWorkerCapacity;
  }

  const { source, value: subagents } = user;

  if (!isRecord(subagents)) {
    throw new Error(
      `Invalid Tau config ${source}: subagents must be an object such as {"capacity": ${defaultWorkerCapacity}}.`,
    );
  }

  warnUnknownKeys(ui, source, subagents, knownSubagentsKeys, 'subagents');

  const { capacity } = subagents;

  if (capacity === undefined) {
    return defaultWorkerCapacity;
  }

  if (!isInteger(capacity) || capacity < 1 || capacity > maximumWorkerCapacity) {
    throw new Error(
      `Invalid Tau config ${source}: subagents.capacity must be an integer from 1 to ${maximumWorkerCapacity}.`,
    );
  }

  return capacity;
};
