import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// pi-web-access keeps the config path from its first load in a module instance. Another test file
// in the same worker may load it first, so the caller gets its own instance through a distinct URL.
// The wrapper re-exports that instance for Pi to load as an extension.
export const createWebAccessExtension = (directory: string): string => {
  const webAccessUrl = pathToFileURL(
    join(import.meta.dirname, '../node_modules/pi-web-access/dist/index.js'),
  );

  webAccessUrl.search = `?instance=${encodeURIComponent(directory)}`;

  const extensionPath = join(directory, 'webAccess.mjs');

  writeFileSync(extensionPath, `export { default } from ${JSON.stringify(webAccessUrl.href)};\n`);

  return extensionPath;
};
