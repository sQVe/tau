export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export const isMissingFile = (error: unknown): boolean => hasErrorCode(error, 'ENOENT');
