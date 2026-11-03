export type HandoverReplyStatus = 'started' | 'notStarted';

export const replySendStatus = (started: boolean | null | undefined): HandoverReplyStatus =>
  started === true ? 'started' : 'notStarted';

export const errorSendStatus = (errorKind: string): 'blocked' | undefined =>
  errorKind === 'blocked' ? 'blocked' : undefined;
