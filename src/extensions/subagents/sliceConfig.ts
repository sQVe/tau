import { isRecord, readUserOnlyKey } from '../../tauConfig/index.js';
import type { ConfigLocation } from '../../tauConfig/index.js';

// The start-slice skill finds the team by this prefix, and stops when the line is missing or
// reports an error.
const agentTeamPrefix = 'The agent team for slice agent tickets';

export const readSliceAgentTeam = (location: ConfigLocation): string | undefined => {
  const user = readUserOnlyKey(location, 'slice');

  if (user === undefined) {
    return undefined;
  }

  const { source, value: slice } = user;

  if (!isRecord(slice)) {
    throw new Error(
      `Invalid Tau config ${source}: slice must be an object such as {"agentTeam": "AI"}.`,
    );
  }

  const unknownKey = Object.keys(slice).find((key) => key !== 'agentTeam');

  if (unknownKey !== undefined) {
    throw new Error(
      `Invalid Tau config ${source}: slice.${unknownKey} is not a known key. Set only agentTeam.`,
    );
  }

  if (slice.agentTeam === undefined) {
    return undefined;
  }

  if (typeof slice.agentTeam !== 'string' || slice.agentTeam.trim() === '') {
    throw new Error(
      `Invalid Tau config ${source}: slice.agentTeam must be a non-empty Linear team key.`,
    );
  }

  return slice.agentTeam;
};

// Prompt building cannot report an error, so an invalid config becomes a line the manager shows.
export const agentTeamLine = (location: ConfigLocation): string[] => {
  let team: string | undefined;

  try {
    team = readSliceAgentTeam(location);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return [`${agentTeamPrefix} could not be read: ${message}`];
  }

  return team === undefined ? [] : [`${agentTeamPrefix} is \`${team}\` (slice.agentTeam).`];
};
