export interface ArchitectInboxFacts {
  state: string;
  inboxLabel: string | undefined;
}

export type ArchitectInboxDecision = 'send' | 'inboxMissing';

export const decideArchitectInbox = (facts: ArchitectInboxFacts): ArchitectInboxDecision => {
  const missingInbox = facts.inboxLabel === undefined || facts.inboxLabel === '';

  return facts.state === 'live' && missingInbox ? 'inboxMissing' : 'send';
};
