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

// Returns the failure that came before the release, adding the release failure when it fails. A
// release that throws synchronously must not hide the earlier failure.
export const failureWithRelease = async (
  failure: unknown,
  release: () => Promise<void>,
  labels: { failure: string; release: string },
): Promise<unknown> => {
  try {
    await release();
  } catch (error) {
    const message = `${labels.failure}: ${errorMessage(failure)}; ${labels.release}: ${errorMessage(error)}`;

    return new Error(message, { cause: failure });
  }

  return failure;
};

export const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export const isMissingFile = (error: unknown): boolean => hasErrorCode(error, 'ENOENT');
