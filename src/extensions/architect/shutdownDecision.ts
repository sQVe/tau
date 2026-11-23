import type { SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

export type ShutdownReason = SessionShutdownEvent['reason'];

export const endsArchitect = (reason: ShutdownReason): boolean => reason !== 'reload';
