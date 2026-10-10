import { isRecord } from '../../isRecord.js';
import { readUserOnlyKey, warnUnknownKeys } from '../../tauConfig.js';
import type { ConfigLocation, ConfigWarnings } from '../../tauConfig.js';
import type { KnownKeys } from '../../unknownKeys.js';

const knownBrowserKeys: KnownKeys = { loginCommand: true };

// The manager asks the user to run this command, so only the user file may set it.
export const readBrowserLoginCommand = (
  location: ConfigLocation,
  ui: ConfigWarnings,
): string | undefined => {
  const user = readUserOnlyKey(location, 'browser');

  if (user === undefined) {
    return undefined;
  }

  const { source, value: browser } = user;

  if (!isRecord(browser)) {
    throw new Error(
      `Invalid Tau config ${source}: browser must be an object such as {"loginCommand": "command"}.`,
    );
  }

  warnUnknownKeys(ui, source, browser, knownBrowserKeys, 'browser');

  const command = browser.loginCommand;

  if (command === undefined) {
    return undefined;
  }

  if (typeof command !== 'string') {
    throw new TypeError(`Invalid Tau config ${source}: browser.loginCommand must be a string.`);
  }

  if (!command.trim()) {
    throw new Error(`Invalid Tau config ${source}: browser.loginCommand is empty.`);
  }

  return command;
};
