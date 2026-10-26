export interface TicketOwners {
  assignee: string | null;
  creator: string | null;
}

// A ticket is the viewer's own when the viewer is its assignee, or when it has no assignee and the
// viewer created it. Unknown ownership counts as another person's.
export const isViewersTicket = (viewer: string, ticket: TicketOwners): boolean =>
  ticket.assignee === null ? ticket.creator === viewer : ticket.assignee === viewer;
