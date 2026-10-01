import { isRecord, readUserOnlyKey } from '../../tauConfig/index.js';
import type { ConfigLocation } from '../../tauConfig/index.js';

// The manager asks the user to run this command, so only the user file may set it.
export const readBrowserLoginCommand = (location: ConfigLocation): string | undefined => {
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

  const unknownKey = Object.keys(browser).find((key) => key !== 'loginCommand');

  if (unknownKey !== undefined) {
    throw new Error(
      `Invalid Tau config ${source}: browser.${unknownKey} is not a known key. Set only loginCommand.`,
    );
  }

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
