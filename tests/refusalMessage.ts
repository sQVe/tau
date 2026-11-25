import { errorMessage } from '../src/errors.js';

export const launchRefusalMessage = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return errorMessage(error);
  }

  throw new Error('The launch was not refused.');
};
