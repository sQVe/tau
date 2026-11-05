export interface InboxEventFact {
  method: string;
  type?: string | undefined;
}

export type InboxEventScan = 'scan' | 'ignore';

export const decideInboxEventScan = (event: InboxEventFact): InboxEventScan => {
  if (event.method === 'missed') {
    return 'scan';
  }

  const isLabelsEvent = event.method === 'event' && event.type === 'labels';

  return isLabelsEvent ? 'scan' : 'ignore';
};
