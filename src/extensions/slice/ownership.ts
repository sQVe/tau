export interface TicketOwners {
  assignee: string | null;
  creator: string | null;
}

export const isViewersTicket = (viewer: string, ticket: TicketOwners): boolean =>
  ticket.assignee === null ? ticket.creator === viewer : ticket.assignee === viewer;
