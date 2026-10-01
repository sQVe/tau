import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { publish, recordEvent, validateTask } from '../records.js';
import { fixtureLoadout } from './loadout.js';

// Saves a manager session and accepted worker tasks under `workers`, as the history readers expect.
export const createLedgerFixture = (directory: string, workers: string) => {
  const sessions = join(directory, 'sessions');
  mkdirSync(sessions, { recursive: true });
  mkdirSync(workers, { recursive: true });

  const session = (id: string, path: string, parentSession?: string) => {
    const header = {
      type: 'session',
      version: 3,
      id,
      timestamp: new Date(0).toISOString(),
      cwd: directory,
      ...(parentSession === undefined ? {} : { parentSession }),
    };

    writeFileSync(path, `${JSON.stringify(header)}\n`);

    return path;
  };

  const manager = session('manager', join(sessions, 'manager.jsonl'));
  const current = { file: manager, id: 'manager', sessionDirectory: sessions };

  const task = (taskId: string, extra: Record<string, unknown> = {}) => {
    const taskDirectory = join(workers, taskId);
    mkdirSync(taskDirectory);

    const nativeSessionFile = session(
      `native-${taskId}`,
      join(taskDirectory, 'native.jsonl'),
      manager,
    );

    const record = validateTask({
      version: 6,
      taskId,
      task: 'Inspect shared source.',
      parentSession: manager,
      parentSessionId: 'manager',
      nativeSessionId: `native-${taskId}`,
      nativeSessionFile,
      createdAt: 1000,
      deadline: 20000,
      cancellationBudget: 1000,
      monotonicDeadline: 20000,
      loadout: fixtureLoadout(directory),
      ...extra,
    });

    publish(taskDirectory, 'task.json', record);
    recordEvent(taskDirectory, taskId, 'accepted', { detail: 'Accepted.' });

    return { taskDirectory, record };
  };

  return { workers, current, task };
};
