// Callers report errors from catch blocks, so this must not throw. JSON throws on cycles and BigInt.
const describeObject = (error: unknown): string => {
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
};

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error !== 'object' || error === null) {
    return String(error);
  }

  const message: unknown = 'message' in error ? error.message : undefined;

  return typeof message === 'string' ? message : describeObject(error);
};

export const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export const isMissingFile = (error: unknown): boolean => hasErrorCode(error, 'ENOENT');
