import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// A pipe opens without a writer only in non-blocking mode. The type check and the read use this one
// handle, so the path cannot change between them.
export const readRegularFile = async (file: string): Promise<Buffer> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error('it is not a regular file');
    }

    return await handle.readFile();
  } finally {
    await handle.close();
  }
};
