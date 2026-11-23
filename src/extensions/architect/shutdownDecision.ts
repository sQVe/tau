import type { SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

export type ShutdownReason = SessionShutdownEvent['reason'];

// A reload restarts the same session in the same pane, so it is not an end the lead must hear about.
export const endsArchitect = (reason: ShutdownReason): boolean => reason !== 'reload';
