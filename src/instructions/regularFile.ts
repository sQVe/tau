import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export interface RegularFileReadOptions {
  noFollow?: boolean;
  notRegularMessage?: string;
  hardLinkMessage?: string;
}

// A pipe opens without a writer only in non-blocking mode. The type check and the read use this one
// handle, so the path cannot change between them.
export const readRegularFile = async (
  file: string,
  options: RegularFileReadOptions = {},
): Promise<Buffer> => {
  const flags =
    options.noFollow === true
      ? constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
      : constants.O_RDONLY | constants.O_NONBLOCK;

  const handle = await open(file, flags);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error(options.notRegularMessage ?? 'it is not a regular file');
    }

    if (options.hardLinkMessage !== undefined && stats.nlink > 1) {
      throw new Error(options.hardLinkMessage);
    }

    return await handle.readFile();
  } finally {
    await handle.close();
  }
};
