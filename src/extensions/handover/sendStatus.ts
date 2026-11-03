export type HandoverSendStatus = 'started' | 'notStarted' | 'blocked';

export const replySendStatus = (started: boolean | null | undefined): HandoverSendStatus =>
  started === true ? 'started' : 'notStarted';

// An undefined status means the caller rethrows the error.
export const errorSendStatus = (errorKind: string): 'blocked' | undefined =>
  errorKind === 'blocked' ? 'blocked' : undefined;
