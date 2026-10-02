import { isRecord, readUserOnlyKey } from '../../tauConfig.js';
import type { ConfigLocation } from '../../tauConfig.js';

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

  if (typeof slice.agentTeam !== 'string') {
    throw new TypeError(`Invalid Tau config ${source}: slice.agentTeam must be a string.`);
  }

  // The team becomes part of one prompt line, and a Linear team key has no whitespace.
  if (!/^\S+$/u.test(slice.agentTeam)) {
    throw new Error(
      `Invalid Tau config ${source}: slice.agentTeam must be a Linear team key such as "AI", with no spaces or line breaks.`,
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
