export const selectExactFiles = (
  discoveredFiles: readonly string[],
  allowedFiles: ReadonlySet<string>,
): string[] => discoveredFiles.filter((file) => allowedFiles.has(file));
