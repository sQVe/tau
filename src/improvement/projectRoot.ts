import { errorMessage } from '../errors.ts';
import { findSharedRepositoryRoot } from '../tauDirectory.ts';

export const projectRootsOf = (indexed: readonly string[], current: string | null): string[] =>
  [...new Set(current === null ? indexed : [...indexed, current])].toSorted();

const isNotARepository = (message: string) => message.includes('not a git repository');

export const findOptionalProjectRoot = async (cwd: string): Promise<string | null> => {
  try {
    return await findSharedRepositoryRoot(cwd);
  } catch (error) {
    if (isNotARepository(errorMessage(error))) {
      return null;
    }

    throw error;
  }
};
