export type ReadFailureDecision = 'filesystem' | 'other';

export interface ReadFailureFacts {
  hasRefusalProof: boolean;
  error: unknown;
}

const isNodeFileError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = 'code' in error ? error.code : undefined;
  const errno = 'errno' in error ? error.errno : undefined;
  const syscall = 'syscall' in error ? error.syscall : undefined;

  return typeof code === 'string' && typeof errno === 'number' && typeof syscall === 'string';
};

export const readFailureDecision = ({
  hasRefusalProof,
  error,
}: ReadFailureFacts): ReadFailureDecision => {
  if (!hasRefusalProof) {
    return 'other';
  }

  if (!isNodeFileError(error)) {
    return 'other';
  }

  return 'filesystem';
};
