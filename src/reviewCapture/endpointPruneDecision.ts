export type DirectoryState = 'absent' | 'record' | 'noRecord' | 'unknown';

export interface EndpointPruneFacts {
  directories: DirectoryState[];
  lastWrite: number | undefined;
  fixNeedsRef: boolean;
  now: number;
}

const interruptedAfterMilliseconds = 86_400_000;

const isInterrupted = (lastWrite: number | undefined, now: number) =>
  lastWrite !== undefined && now - lastWrite >= interruptedAfterMilliseconds;

export const decideEndpointPrune = ({
  directories,
  lastWrite,
  fixNeedsRef,
  now,
}: EndpointPruneFacts): boolean => {
  if (directories.includes('record') || directories.includes('unknown')) {
    return false;
  }

  if (fixNeedsRef) {
    return false;
  }

  if (directories.includes('noRecord')) {
    return isInterrupted(lastWrite, now);
  }

  return true;
};
