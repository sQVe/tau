export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error !== 'object' || error === null) {
    return String(error);
  }

  const message: unknown = 'message' in error ? error.message : undefined;

  return typeof message === 'string' ? message : JSON.stringify(error);
};

export const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export const isMissingFile = (error: unknown): boolean => hasErrorCode(error, 'ENOENT');
