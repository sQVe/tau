export type EventScanAction = 'scan' | 'ignore';

export interface EventFact {
  method: string;
  type?: string | undefined;
}

const scanEventTypes: ReadonlySet<string> = new Set(['labels', 'finished']);

export const decideEventScan = (event: EventFact): EventScanAction => {
  if (event.method === 'missed') {
    return 'scan';
  }

  if (event.method === 'event' && event.type !== undefined && scanEventTypes.has(event.type)) {
    return 'scan';
  }

  return 'ignore';
};
