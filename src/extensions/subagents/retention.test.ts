import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as promises from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { recordEvent } from './records.js';
import { deleteExpiredWorkers } from './retention.js';
import { retentionMilliseconds } from './retentionDecision.js';

interface SavedFixture {
  task?: object | string;
  stopped?: boolean;
  cleanupTaskId?: string;
  cleanupKind?: string;
  recent?: boolean;
}

vi.mock(import('node:fs'), { spy: true });
vi.mock(import('node:fs/promises'), { spy: true });

const savedTask = join(import.meta.dirname, 'fixtures', 'taskRecords', 'current-pi.json');
const now = Date.now();
const old = new Date(now - retentionMilliseconds - 60_000);

const makeOld = (directory: string) => {
  for (const entry of readdirSync(directory)) {
    utimesSync(join(directory, entry), old, old);
  }

  utimesSync(directory, old, old);
};

const saveWorker = (root: string, taskId: string, saved: SavedFixture) => {
  const directory = join(root, taskId);
  const template = JSON.parse(readFileSync(savedTask, 'utf8')) as object;
  const task = saved.task ?? {};
  const text = typeof task === 'string' ? task : JSON.stringify({ ...template, taskId, ...task });

  mkdirSync(directory);
  writeFileSync(join(directory, 'task.json'), text);

  if (saved.stopped === true) {
    const cleanup = {
      taskId: saved.cleanupTaskId ?? taskId,
      kind: saved.cleanupKind ?? 'cleanup',
      detail: 'Stopped.',
      stopped: true,
      at: 1000,
    };

    writeFileSync(join(directory, 'cleanup.json'), JSON.stringify(cleanup));
  }

  if (saved.recent !== true) {
    makeOld(directory);
  }
};

const saveRecentReport = (root: string, taskId: string) => {
  const directory = join(root, taskId);

  saveWorker(root, taskId, { stopped: true });
  writeFileSync(join(directory, 'report.json'), '{}');
  utimesSync(directory, old, old);
};

it('deletes only expired stopped workers that no kept task needs', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');

  saveWorker(root, 'old-stopped', { stopped: true });
  saveWorker(root, 'old-retired', { task: '{"version":1,"nativeSessionFile":42}', stopped: true });
  saveWorker(root, 'old-malformed', { task: '{', stopped: true });
  saveWorker(root, 'old-running', {});
  saveWorker(root, 'old-foreign-cleanup', { stopped: true, cleanupTaskId: 'another-task' });
  saveWorker(root, 'old-wrong-kind', { stopped: true, cleanupKind: 'accepted' });
  saveWorker(root, 'old-session', { stopped: true });
  saveWorker(root, 'old-source', { stopped: true });
  saveWorker(root, 'old-predecessor', { stopped: true });
  saveWorker(root, 'recent-stopped', { stopped: true, recent: true });
  mkdirSync(join(root, 'unpublished'));
  saveWorker(root, '.admission', { stopped: true });
  saveRecentReport(root, 'recent-report');
  writeFileSync(join(root, 'stray-file'), '');

  saveWorker(root, 'follow-up', {
    task: {
      nativeSessionFile: join(root, 'old-source', 'native.jsonl'),
      predecessorTaskId: 'old-predecessor',
    },
    recent: true,
  });

  saveWorker(root, 'outside-native', {
    task: { nativeSessionFile: join('/elsewhere', 'old-stopped', 'native.jsonl') },
    recent: true,
  });

  const deleted = await deleteExpiredWorkers(root, new Set(['old-session']), now);

  expect(deleted.toSorted()).toEqual(['old-malformed', 'old-retired', 'old-stopped']);

  expect(readdirSync(root).toSorted()).toEqual([
    '.admission',
    'follow-up',
    'old-foreign-cleanup',
    'old-predecessor',
    'old-running',
    'old-session',
    'old-source',
    'old-wrong-kind',
    'outside-native',
    'recent-report',
    'recent-stopped',
    'stray-file',
    'unpublished',
  ]);
});

it('deletes nothing when no worker was saved', async () => {
  const root = join(temporaryDirectory(onTestFinished, 'tau-retention-'), 'workers');

  await expect(deleteExpiredWorkers(root, new Set(), now)).resolves.toEqual([]);
});

it('refuses when the worker root cannot be listed', async () => {
  const root = join(temporaryDirectory(onTestFinished, 'tau-retention-'), 'workers');

  writeFileSync(root, '');

  await expect(deleteExpiredWorkers(root, new Set(), now)).rejects.toThrow('ENOTDIR');
});

// Runs before retention reads the metadata of one path, as another process would.
const beforeMetadataRead = async (path: string, change: () => void) => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  let changed = false;

  vi.mocked(fs.lstatSync).mockImplementation(((target: fs.PathLike, options?: never) => {
    if (target === path && !changed) {
      changed = true;
      change();
    }

    return actual.lstatSync(target, options);
  }) as typeof fs.lstatSync);

  onTestFinished(() => {
    vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
  });
};

// Runs before or after retention reads one task record, as another process would.
const onTaskRead = async (path: string, timing: 'before' | 'after', change: () => void) => {
  const actual = await vi.importActual<typeof promises>('node:fs/promises');
  let changed = false;

  vi.mocked(promises.readFile).mockImplementation(
    async (...parameters: Parameters<typeof promises.readFile>) => {
      const matches = parameters[0] === path && !changed;

      if (matches && timing === 'before') {
        changed = true;
        change();
      }

      const text = await actual.readFile(...parameters);

      if (matches && timing === 'after') {
        changed = true;
        change();
      }

      return text;
    },
  );

  onTestFinished(() => {
    vi.mocked(promises.readFile).mockImplementation(actual.readFile);
  });
};

const saveSourceWithSuccessor = (root: string) => {
  const nativeSessionFile = join(root, 'old-source', 'native.jsonl');

  saveWorker(root, 'old-source', { stopped: true });
  writeFileSync(nativeSessionFile, 'conversation\n');
  makeOld(join(root, 'old-source'));

  saveWorker(root, 'successor', {
    task: { predecessorTaskId: 'old-source', nativeSessionFile },
    recent: true,
  });

  return nativeSessionFile;
};

it('keeps the source of a successor whose publication file vanishes during the scan', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');
  const nativeSessionFile = saveSourceWithSuccessor(root);
  const receipt = join(root, 'successor', '.receipt-publisher');

  writeFileSync(receipt, '{}');

  await beforeMetadataRead(receipt, () => {
    unlinkSync(receipt);
  });

  await expect(deleteExpiredWorkers(root, new Set(), now)).resolves.toEqual([]);
  expect(existsSync(nativeSessionFile)).toBe(true);
});

it('keeps a worker whose files cannot be read and the tasks it points to, and deletes others', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');
  const nativeSessionFile = saveSourceWithSuccessor(root);
  const cleanup = { taskId: 'successor', kind: 'cleanup', detail: 'Stopped.', at: 1000 };

  writeFileSync(
    join(root, 'successor', 'cleanup.json'),
    JSON.stringify({ ...cleanup, stopped: true }),
  );

  makeOld(join(root, 'successor'));
  saveWorker(root, 'unrelated', { stopped: true });

  await beforeMetadataRead(join(root, 'successor', 'task.json'), () => {
    throw Object.assign(new Error('Permission denied.'), { code: 'EACCES' });
  });

  await expect(deleteExpiredWorkers(root, new Set(), now)).resolves.toEqual(['unrelated']);
  expect(existsSync(nativeSessionFile)).toBe(true);
});

it.each([
  {
    case: 'an unparseable task record',
    save: (directory: string) => {
      writeFileSync(join(directory, 'task.json'), '{');
    },
  },
  {
    case: 'a vanished directory',
    save: (directory: string) => {
      fs.rmSync(directory, { recursive: true });
    },
  },
])('deletes nothing when a kept worker has $case', async ({ save }) => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');

  saveWorker(root, 'old-stopped', { stopped: true });
  saveWorker(root, 'recent', { recent: true });

  await onTaskRead(join(root, 'recent', 'task.json'), 'before', () => {
    save(join(root, 'recent'));
  });

  await expect(deleteExpiredWorkers(root, new Set(), now)).resolves.toEqual([]);
  expect(existsSync(join(root, 'old-stopped'))).toBe(true);
});

// Another process confirms the stop of an old worker while retention reads its task record.
it('keeps a worker whose stop is confirmed during the scan', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');
  const nativeSessionFile = join(root, 'old-running', 'native.jsonl');

  saveWorker(root, 'old-running', {});
  writeFileSync(nativeSessionFile, 'conversation\n');
  makeOld(join(root, 'old-running'));

  await onTaskRead(join(root, 'old-running', 'task.json'), 'after', () => {
    recordEvent(join(root, 'old-running'), 'old-running', 'cleanup', {
      detail: 'Stopped.',
      stopped: true,
    });
  });

  await expect(deleteExpiredWorkers(root, new Set(), now)).resolves.toEqual([]);
  expect(existsSync(nativeSessionFile)).toBe(true);
});

it('stops the pass when a worker it decided to delete is written before deletion', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');

  saveWorker(root, 'old-a', { stopped: true });
  saveWorker(root, 'old-b', { stopped: true });

  const actual = await vi.importActual<typeof fs>('node:fs');
  let listings = 0;

  vi.mocked(fs.readdirSync).mockImplementation(
    (...parameters: Parameters<typeof fs.readdirSync>) => {
      // The second listing of each directory is the check just before deletion.
      if (String(parameters[0]).startsWith(root) && ++listings === 3) {
        writeFileSync(join(root, 'old-a', 'report.json'), '{}');
        writeFileSync(join(root, 'old-b', 'report.json'), '{}');
      }

      return actual.readdirSync(...parameters);
    },
  );

  onTestFinished(() => {
    vi.mocked(fs.readdirSync).mockImplementation(actual.readdirSync);
  });

  await expect(deleteExpiredWorkers(root, new Set(), now)).resolves.toEqual([]);
  expect(readdirSync(root).toSorted()).toEqual(['old-a', 'old-b']);
});

// A task record cut off by a crash, as found in a real store, without a cleanup record.
it.each([
  {
    case: 'deletes an unparseable record older than 14 days',
    recent: false,
    deleted: ['crashed', 'old-stopped'],
  },
  { case: 'keeps everything while an unparseable record is recent', recent: true, deleted: [] },
])('$case', async ({ recent, deleted }) => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');

  saveWorker(root, 'old-stopped', { stopped: true });
  saveWorker(root, 'crashed', { task: '{', recent });

  const removed = await deleteExpiredWorkers(root, new Set(), now);

  expect(removed.toSorted()).toEqual(deleted);
});

// A permission change on a valid record is a read error, not a malformed record.
it('deletes nothing while an old task record cannot be read', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');
  const nativeSessionFile = join(root, 'old-source', 'native.jsonl');
  const record = join(root, 'successor', 'task.json');

  saveWorker(root, 'old-source', { stopped: true });
  writeFileSync(nativeSessionFile, 'conversation\n');
  makeOld(join(root, 'old-source'));
  saveWorker(root, 'successor', { task: { predecessorTaskId: 'old-source', nativeSessionFile } });
  saveWorker(root, 'unrelated', { stopped: true });
  fs.chmodSync(record, 0o000);

  onTestFinished(() => {
    fs.chmodSync(record, 0o600);
  });

  await expect(deleteExpiredWorkers(root, new Set(), now)).resolves.toEqual([]);
  expect(readdirSync(root).toSorted()).toEqual(['old-source', 'successor', 'unrelated']);
  expect(existsSync(nativeSessionFile)).toBe(true);
});

// The follow-up was written after the scan, so the decision about its old source is stale too.
it('keeps the old source when the follow-up it decided to delete is written before deletion', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');
  const nativeSessionFile = join(root, 'old-b', 'native.jsonl');

  saveWorker(root, 'old-b', { stopped: true });
  writeFileSync(nativeSessionFile, 'conversation\n');
  makeOld(join(root, 'old-b'));

  saveWorker(root, 'old-a', {
    stopped: true,
    task: { predecessorTaskId: 'old-b', nativeSessionFile },
  });

  const actual = await vi.importActual<typeof fs>('node:fs');
  let followUpListings = 0;

  vi.mocked(fs.readdirSync).mockImplementation(
    (...parameters: Parameters<typeof fs.readdirSync>) => {
      // The second listing of the follow-up is the check just before its deletion.
      if (parameters[0] === join(root, 'old-a') && ++followUpListings === 2) {
        writeFileSync(join(root, 'old-a', 'report.json'), '{}');
      }

      return actual.readdirSync(...parameters);
    },
  );

  onTestFinished(() => {
    vi.mocked(fs.readdirSync).mockImplementation(actual.readdirSync);
  });

  await expect(deleteExpiredWorkers(root, new Set(), now)).resolves.toEqual([]);
  expect(existsSync(nativeSessionFile)).toBe(true);
});

// Another startup pass removes the same directory after this pass checked its age.
it('deletes a directory that another pass removed after the age check', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-retention-');

  saveWorker(root, 'old-a', { stopped: true });
  saveWorker(root, 'old-b', { stopped: true });

  const actual = await vi.importActual<typeof promises>('node:fs/promises');

  vi.mocked(promises.rm).mockImplementation(
    async (...parameters: Parameters<typeof promises.rm>) => {
      if (parameters[0] === join(root, 'old-a')) {
        await actual.rm(parameters[0], { recursive: true });
      }

      return actual.rm(...parameters);
    },
  );

  onTestFinished(() => {
    vi.mocked(promises.rm).mockImplementation(actual.rm);
  });

  const deleted = await deleteExpiredWorkers(root, new Set(), now);

  expect(deleted.toSorted()).toEqual(['old-a', 'old-b']);
  expect(readdirSync(root)).toEqual([]);
});
