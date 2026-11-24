import type { SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

export type ShutdownReason = SessionShutdownEvent['reason'];

export const endsArchitect = (reason: ShutdownReason): boolean => reason !== 'reload';

// Every reason except quit replaces the runtime in the same process, so the next runtime keeps the
// lock instead of releasing it first.
export const keepsLock = (reason: ShutdownReason): boolean => reason !== 'quit';
