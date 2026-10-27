import { isViewersTicket } from './ownership.js';
import type { TicketOwners } from './ownership.js';
import type { SliceWrite } from './writes.js';

export interface ExistingTicket extends TicketOwners {
  identifier: string;
}

const isPresent = (identifier: string | null): identifier is string => identifier !== null;

// A slice number has no identifier until apply creates it, so its write changes no existing ticket.
const identifierOf = (sliceIdentifiers: readonly (string | null)[], number: number) =>
  sliceIdentifiers[number - 1] ?? null;

// Lists the existing tickets a write changes. A create changes none. A relation changes both
// tickets it links.
const changedIdentifiers = (
  write: SliceWrite,
  sliceIdentifiers: readonly (string | null)[],
): (string | null)[] => {
  if (write.kind === 'createContainer' || write.kind === 'createSlice') {
    return [];
  }

  if (write.kind === 'addBlockedBy') {
    return [
      identifierOf(sliceIdentifiers, write.number),
      identifierOf(sliceIdentifiers, write.blocker),
    ];
  }

  if (write.kind === 'removeBlockedBy') {
    return [write.identifier, write.blocker];
  }

  return [write.identifier];
};

// A ticket missing from the read has no known owner, so it counts as not the viewer's.
const isForeign = (viewer: string, tickets: readonly ExistingTicket[], identifier: string) => {
  const ticket = tickets.find((candidate) => candidate.identifier === identifier);

  return ticket === undefined || !isViewersTicket(viewer, ticket);
};

// Returns each existing ticket that a planned write changes and the viewer does not own, once.
// sliceIdentifiers holds the identifier the draft records for each slice number, or null.
export const decideForeignWrites = (
  viewer: string,
  writes: readonly SliceWrite[],
  sliceIdentifiers: readonly (string | null)[],
  tickets: readonly ExistingTicket[],
): string[] => {
  const changed = writes.flatMap((write) => changedIdentifiers(write, sliceIdentifiers));
  const present = changed.filter(isPresent);
  const foreign = present.filter((identifier) => isForeign(viewer, tickets, identifier));

  return [...new Set(foreign)];
};
