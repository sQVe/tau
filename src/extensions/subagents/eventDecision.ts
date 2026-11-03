import { lastRetryDelay, retryDelay } from './deadlineDecision.js';

export type EventScanAction = 'scan' | 'ignore';

export interface EventFact {
  method: string;
  type?: string | undefined;
}

export interface ReconnectPlan {
  delay: number;
  lasting: boolean;
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

// A failed subscription keeps retrying for the session, at the last delay once the schedule ends.
export const decideReconnect = (attempt: number): ReconnectPlan => {
  const next = retryDelay(attempt);

  return next === undefined
    ? { delay: lastRetryDelay, lasting: true }
    : { delay: next, lasting: false };
};
