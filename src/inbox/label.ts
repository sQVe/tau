import { join } from 'node:path';

import { withFileLock } from '../fileLock/fileLock.js';
import { get, label } from '../hc/hc.js';
import type { HcRuntime } from '../hc/hc.js';
import { inboxLock } from './endpoint.js';
import { formatInboxLabel, inboxLabelKey } from './protocol.js';

export interface LabelOptions {
  hc: HcRuntime;
  terminal: string;
  directory: string;
  path: string;
}

const labelLockPath = (directory: string, terminal: string): string =>
  join(directory, `${encodeURIComponent(terminal)}.label.lock`);

const withLabelLock = (options: LabelOptions, write: () => Promise<void>): Promise<void> =>
  withFileLock(inboxLock(labelLockPath(options.directory, options.terminal)), write);

export const advertiseLabel = (options: LabelOptions): Promise<void> =>
  withLabelLock(options, async () => {
    await label(options.hc, options.terminal, {
      [inboxLabelKey]: formatInboxLabel(options.path),
    });
  });

export const withdrawLabel = (options: LabelOptions): Promise<void> =>
  withLabelLock(options, async () => {
    const terminal = await get(options.hc, options.terminal);

    if (terminal.labels?.[inboxLabelKey] !== formatInboxLabel(options.path)) {
      return;
    }

    await label(options.hc, options.terminal, { [inboxLabelKey]: '' });
  });
