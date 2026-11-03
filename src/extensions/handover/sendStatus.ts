export type HandoverReplyStatus = 'started' | 'notStarted';

export const replySendStatus = (started: boolean | null | undefined): HandoverReplyStatus =>
  started === true ? 'started' : 'notStarted';

// An undefined status means the caller rethrows the error.
export const errorSendStatus = (errorKind: string): 'blocked' | undefined =>
  errorKind === 'blocked' ? 'blocked' : undefined;
