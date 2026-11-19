import { realpathSync } from 'node:fs';

// Resolves an existing path and keeps the original when it cannot be resolved.
export const resolveExistingPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
