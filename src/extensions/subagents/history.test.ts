import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext, SessionInfo } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { WorkerController } from './controller/controller.js';
import { taskStatus } from './controller/record.js';
import { fixtureGenericLoadout, fixtureLoadout } from './fixtures/loadout.js';
import { searchHistory } from './history.js';
import subagentsExtension from './index.js';
import {
  acceptReport,
  publish,
  readTask,
  recordEvent,
  validateTask,
  workerRecordsDirectory,
} from './records.js';
import { requireNativeTask } from './types.js';

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-history-'));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  const sessions = join(directory, 'custom-sessions');
  const workers = workerRecordsDirectory();
  mkdirSync(sessions, { recursive: true });
  mkdirSync(workers, { recursive: true });
  const session = (id: string, parentSession?: string, path = join(sessions, `${id}.jsonl`)) => {
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(0).toISOString(), cwd: directory, ...(parentSession ? { parentSession } : {}) })}\n`,
    );

    return path;
  };
  const root = session('root');
  const child = session('child', root);
  const sibling = session('sibling', root);
  const unrelated = session('unrelated');
  const task = (
    id: string,
    parentSession: string,
    parentSessionId: string,
    name?: string,
    large = false,
  ) => {
    const taskDirectory = join(workers, id);
    mkdirSync(taskDirectory);
    const nativeSessionId = `native-${id}`;
    const nativeSessionFile = session(
      nativeSessionId,
      parentSession,
      join(taskDirectory, 'native.jsonl'),
    );
    const record = validateTask({
      version: 1,
      taskId: id,
      task: large ? `${'界'.repeat(10000)} needle-tail` : 'Inspect shared source.',
      ...(name ? { name } : {}),
      parentSession,
      parentSessionId,
      nativeSessionId,
      nativeSessionFile,
      createdAt: 1000,
      deadline: 20000,
      cancellationBudget: 1000,
      monotonicDeadline: 20000,
      loadout: fixtureLoadout(directory),
    });
    publish(taskDirectory, 'task.json', record);
    recordEvent(taskDirectory, id, 'cleanup', { detail: 'Pane removed.', stopped: true });
    acceptReport(taskDirectory, id, {
      taskId: id,
      outcome: 'success',
      summary: large ? '界'.repeat(10000) : 'Saved evidence.',
      evidence: large ? ['界'.repeat(5000), '\u0000'.repeat(1000)] : ['Checked source.'],
    });

    return { taskDirectory, record: requireNativeTask(record) };
  };

  return { directory, sessions, workers, root, child, sibling, unrelated, session, task };
};

const historyTool = async (fixture: ReturnType<typeof setup>, file: string, id: string) => {
  const loader = new DefaultResourceLoader({
    cwd: fixture.directory,
    agentDir: fixture.directory,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [subagentsExtension],
  });
  await loader.reload();
  const tool = loader
    .getExtensions()
    .extensions.flatMap((extension) => Array.from(extension.tools.values()))
    .find((entry) => entry.definition.name === 'subagent_history')?.definition;

  if (!tool) {
    throw new Error('History tool missing.');
  }

  const context = {
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => id,
      getSessionDir: () => fixture.sessions,
    },
  } as unknown as ExtensionContext;

  return (parameters: { query?: string; offset?: number; limit?: number }) =>
    tool.execute('history-test', parameters, new AbortController().signal, undefined, context);
};

it('bounds production history output while paging all matches and retaining record retrieval', async () => {
  const fixture = setup();

  for (let index = 0; index < 20; index++) {
    fixture.task(`task-${String(index).padStart(2, '0')}`, fixture.root, 'root', undefined, true);
  }

  const execute = await historyTool(fixture, fixture.root, 'root');
  const response = await execute({ query: 'needle-tail', limit: 1 });
  expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(150000);
  const text = response.content.find((part) => part.type === 'text');

  if (!text) {
    throw new Error('History text missing.');
  }

  expect(Buffer.byteLength(text.text, 'utf8')).toBeLessThanOrEqual(48000);
  const page = JSON.parse(text.text) as {
    outcome: string;
    totalMatches: number;
    nextOffset: number;
    candidates: {
      description: string;
      state: string;
      truncatedFields: string[];
      reportFile: string;
      report: { summary: string };
    }[];
  };

  expect(page).toMatchObject({ outcome: 'clarification', totalMatches: 20, nextOffset: 1 });
  expect(page.candidates).toHaveLength(1);
  expect(page.candidates[0]?.truncatedFields).toEqual(
    expect.arrayContaining(['description', 'report.summary', 'report.evidence']),
  );
  expect(page.candidates[0]?.description.length).toBeLessThan(1000);
  expect(page.candidates[0]?.report.summary.length).toBeLessThan(1000);
  expect(page.candidates[0]?.state).toBe('stopped');
  expect(page.candidates[0]).not.toHaveProperty('sourceFile');
  expect(page.candidates[0]).not.toHaveProperty('nativeSessionFile');
  const reportFile = page.candidates[0]?.reportFile ?? '';
  expect(readFileSync(reportFile, 'utf8')).toContain('界'.repeat(10000));
  expect(readFileSync(join(dirname(reportFile), 'task.json'), 'utf8')).toContain('needle-tail');

  for (const removed of [
    'rootSessionId',
    'rootSessionFile',
    'offset',
    'limit',
    'maxBytes',
    'readOnly',
    'retrieval',
    'paging',
    'diagnostics',
  ]) {
    expect(page).not.toHaveProperty(removed);
  }

  expect(text.text).not.toContain('reportFileRelativeToSource');
  const fullPage = await execute({ query: 'needle-tail' });
  const fullPageText = fullPage.content.find((part) => part.type === 'text')?.text ?? '';
  const bounded = JSON.parse(fullPageText) as {
    totalMatches: number;
    candidates: unknown[];
    nextOffset: number;
  };
  expect(Buffer.byteLength(fullPageText, 'utf8')).toBeLessThanOrEqual(48000);
  expect(bounded.totalMatches).toBe(20);
  expect(bounded.candidates.length).toBeLessThan(10);
  expect(bounded.nextOffset).toBe(bounded.candidates.length);
  const last = await execute({ query: 'needle-tail', offset: 18 });
  expect(last.details).not.toHaveProperty('nextOffset');
  expect(last.details).toMatchObject({
    totalMatches: 20,
    candidates: [
      expect.objectContaining({ taskId: 'task-18' }),
      expect.objectContaining({ taskId: 'task-19' }),
    ],
  });
  const second = await execute({ query: 'needle-tail', offset: page.nextOffset, limit: 1 });
  expect(JSON.stringify(second)).toContain('task-01');
  const empty = await execute({ query: 'needle-tail', offset: 20 });
  expect(empty.details).toEqual({ outcome: 'clarification', totalMatches: 20, candidates: [] });
});

it('reads history only from the records of the running Tau checkout', async () => {
  const fixture = setup();
  const otherFolders = [
    join(fixture.directory, 'tau', 'workers'),
    join(fixture.directory, 'tau', 'abu-400-0123abcd', 'workers'),
  ];

  for (const [index, folder] of otherFolders.entries()) {
    const { taskDirectory } = fixture.task(`other-${index}`, fixture.child, 'child');
    mkdirSync(folder, { recursive: true });
    renameSync(taskDirectory, join(folder, `other-${index}`));
  }

  fixture.task('own', fixture.child, 'child');
  const execute = await historyTool(fixture, fixture.root, 'root');
  const response = await execute({});

  const { candidates } = response.details as { candidates: { taskId?: string }[] };

  expect(candidates.flatMap((candidate) => (candidate.taskId ? [candidate.taskId] : []))).toEqual([
    'own',
  ]);
});

it('excludes explicit custom-extension current and root sessions from the production history tool', async () => {
  const fixture = setup();
  const root = fixture.session('explicit-root', undefined, join(fixture.sessions, 'root.session'));
  const current = fixture.session(
    'explicit-current',
    root,
    join(fixture.sessions, 'current.session'),
  );
  const execute = await historyTool(fixture, current, 'explicit-current');
  const result = await execute({ query: 'explicit-' });

  expect(result.details).toEqual({ outcome: 'notFound', totalMatches: 0, candidates: [] });
});

it('keeps the named current session out of history while checking its discovered metadata', async () => {
  const fixture = setup();
  writeFileSync(
    fixture.root,
    readFileSync(fixture.root, 'utf8') +
      [
        {
          type: 'session_info',
          id: 'info',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          name: 'Named root',
        },
        {
          type: 'message',
          id: 'message',
          parentId: 'info',
          timestamp: new Date(0).toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Native description.' }],
            timestamp: 0,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') +
      '\n',
  );
  const execute = await historyTool(fixture, fixture.root, 'root');
  const result = await execute({ query: 'root' });

  expect(result.details).toEqual({ outcome: 'notFound', totalMatches: 0, candidates: [] });
  const history = await searchHistory(fixture.workers, {
    file: fixture.child,
    id: 'child',
    sessionDirectory: fixture.sessions,
  });
  expect(history.candidates.some((candidate) => candidate.name === 'Named root')).toBe(false);
  expect(history.diagnostics).toEqual([]);
});

it('derives successor status and history from task records', async () => {
  const fixture = setup();
  const source = fixture.task('source', fixture.child, 'child');
  const rejectedDirectory = join(fixture.workers, 'rejected');
  const successorDirectory = join(fixture.workers, 'successor');
  mkdirSync(rejectedDirectory);
  mkdirSync(successorDirectory);
  const successor = {
    ...source.record,
    taskId: 'successor',
    predecessorTaskId: source.record.taskId,
  };
  publish(rejectedDirectory, 'task.json', { ...successor, taskId: 'rejected' });
  recordEvent(rejectedDirectory, 'rejected', 'cleanup', { detail: 'Rejected.', stopped: true });
  publish(successorDirectory, 'task.json', successor);

  const history = await searchHistory(fixture.workers, {
    file: fixture.child,
    id: 'child',
    sessionDirectory: fixture.sessions,
  });

  expect(taskStatus(source.taskDirectory).successorTaskId).toBe('successor');
  expect(history.candidates.find((candidate) => candidate.taskId === 'source')).toMatchObject({
    successorTaskId: 'successor',
  });
  expect(history.candidates.find((candidate) => candidate.taskId === 'successor')).toMatchObject({
    predecessorTaskId: 'source',
  });
  expect(history.diagnostics).toEqual([]);
});

it('reports corrupt saved reports as diagnostics without hiding other tasks', async () => {
  const fixture = setup();
  const corruptReport = fixture.task('corrupt-report', fixture.child, 'child');
  fixture.task('intact', fixture.child, 'child');
  writeFileSync(join(corruptReport.taskDirectory, 'report.json'), '{}');

  const history = await searchHistory(fixture.workers, {
    file: fixture.child,
    id: 'child',
    sessionDirectory: fixture.sessions,
  });

  expect(
    history.candidates
      .flatMap((candidate) => (candidate.taskId ? [candidate.taskId] : []))
      .toSorted(),
  ).toEqual(['corrupt-report', 'intact']);
  expect(
    history.candidates.find((candidate) => candidate.taskId === 'corrupt-report'),
  ).not.toHaveProperty('report');
  expect(history.diagnostics.join(' ')).toContain('Task corrupt-report');
});

it('scopes history to the validated root and descendants including siblings and missing native refs', async () => {
  const fixture = setup();
  const first = fixture.task('first', fixture.child, 'child', 'worker-aa');
  const second = fixture.task('second', fixture.sibling, 'sibling');
  fixture.task('outside', fixture.unrelated, 'unrelated', 'worker-aa');
  const nested = fixture.task(
    'nested',
    first.record.nativeSessionFile,
    first.record.nativeSessionId,
    'worker-bb',
  );
  rmSync(first.record.nativeSessionFile);
  const current = { file: fixture.child, id: 'child', sessionDirectory: fixture.sessions };
  const history = await searchHistory(fixture.workers, current);

  expect(
    history.candidates
      .filter((candidate) => candidate.taskId)
      .map((candidate) => candidate.taskId)
      .toSorted((left, right) => String(left).localeCompare(String(right))),
  ).toEqual(['first', 'nested', 'second']);
  const sessionIds = history.candidates.map((candidate) => candidate.nativeSessionId);
  expect(sessionIds).toEqual(expect.arrayContaining(['sibling', nested.record.nativeSessionId]));
  expect(sessionIds).not.toContain('root');
  expect(sessionIds).not.toContain('child');
  expect(history.candidates.find((candidate) => candidate.taskId === 'first')).toMatchObject({
    name: 'worker-aa',
    state: 'stopped',
    nativeEvidence: 'missing',
    report: { summary: 'Saved evidence.' },
  });
  expect(history.candidates.find((candidate) => candidate.taskId === 'second')).not.toHaveProperty(
    'name',
  );
  expect(readTask(second.taskDirectory)).not.toHaveProperty('name');
  const fromRoot = await searchHistory(fixture.workers, {
    ...current,
    file: fixture.root,
    id: 'root',
  });
  expect(fromRoot.candidates.map((candidate) => candidate.nativeSessionId)).toEqual(
    expect.arrayContaining([...sessionIds, 'child']),
  );
  expect(fromRoot.candidates.some((candidate) => candidate.nativeSessionId === 'root')).toBe(false);
  expect(history.candidates.some((candidate) => candidate.nativeSessionId === 'unrelated')).toBe(
    false,
  );
});

it('excludes the calling task and its parent task from history', async () => {
  const fixture = setup();
  const parent = fixture.task('parent-task', fixture.child, 'child');
  const nested = fixture.task(
    'nested-task',
    parent.record.nativeSessionFile,
    parent.record.nativeSessionId,
  );
  const current = {
    file: nested.record.nativeSessionFile,
    id: nested.record.nativeSessionId,
    sessionDirectory: fixture.sessions,
  };
  const history = await searchHistory(fixture.workers, current);
  const taskIds = history.candidates.flatMap((candidate) =>
    candidate.taskId ? [candidate.taskId] : [],
  );

  expect(taskIds).not.toContain('nested-task');
  expect(taskIds).not.toContain('parent-task');
});

it('returns clarification for ambiguous names and descriptions without writing or granting ownership', async () => {
  const fixture = setup();
  const first = fixture.task('first', fixture.child, 'child', 'worker-aa');
  fixture.task('second', fixture.sibling, 'sibling', 'worker-aa');
  const snapshot = () =>
    readdirSync(fixture.directory, { recursive: true })
      .filter((path) => statSync(join(fixture.directory, String(path))).isFile())
      .map((path) => [path, readFileSync(join(fixture.directory, String(path)), 'utf8')]);
  const before = snapshot();
  const current = { file: fixture.root, id: 'root', sessionDirectory: fixture.sessions };
  const named = await searchHistory(fixture.workers, current, 'worker-aa');
  const described = await searchHistory(fixture.workers, current, 'shared source');
  const prefix = await searchHistory(fixture.workers, current, 'native-');

  expect(named.outcome).toBe('clarification');
  expect(
    named.candidates
      .map((candidate) => candidate.taskId)
      .toSorted((left, right) => String(left).localeCompare(String(right))),
  ).toEqual(['first', 'second']);
  expect(described.outcome).toBe('clarification');
  expect(prefix.outcome).toBe('clarification');
  expect(prefix.candidates).toHaveLength(2);
  expect(snapshot()).toEqual(before);
  const controller = new WorkerController(fixture.workers);
  expect(() => controller.status(first.record.taskId, 'root')).toThrow('another parent');
  await expect(controller.cancel(first.record.taskId, 'root')).rejects.toThrow('another parent');
  await expect(
    controller.reply(first.record.taskId, 'root', {
      questionId: 'question',
      replyId: 'reply',
      reply: 'Inspect it.',
      scopeUnchanged: true,
    }),
  ).rejects.toThrow('another parent');
  controller.close();
  expect(snapshot()).toEqual(before);
});

it.each(['broken', 'cyclic', 'mismatched'] as const)(
  'refuses %s current ancestry',
  async (kind) => {
    const fixture = setup();
    const current = {
      file: fixture.child,
      id: kind === 'mismatched' ? 'wrong-id' : 'child',
      sessionDirectory: fixture.sessions,
    };

    if (kind === 'broken') {
      rmSync(fixture.root);
    }

    if (kind === 'cyclic') {
      fixture.session('root', fixture.child, fixture.root);
    }

    await expect(searchHistory(fixture.workers, current)).rejects.toThrow(
      /ancestry|identity|lineage/,
    );
  },
);

it('excludes broken and cyclic discovered sessions and mismatched saved parent identities', async () => {
  const fixture = setup();
  fixture.session('broken', join(fixture.sessions, 'absent.jsonl'));
  const cycle = fixture.session('cycle-one', join(fixture.sessions, 'cycle-two.jsonl'));
  fixture.session('cycle-two', cycle);
  fixture.task('bad-parent', fixture.root, 'wrong-root', 'worker-zz');
  const history = await searchHistory(fixture.workers, {
    file: fixture.root,
    id: 'root',
    sessionDirectory: fixture.sessions,
  });

  expect(
    history.candidates
      .map((candidate) => candidate.nativeSessionId)
      .toSorted((left, right) => String(left).localeCompare(String(right))),
  ).toEqual(['child', 'sibling']);
  expect(history.diagnostics.length).toBeGreaterThanOrEqual(3);
});

it('flags mismatched saved native ancestry without searching an unrelated transcript', async () => {
  const fixture = setup();
  const saved = fixture.task('first', fixture.root, 'root', 'worker-aa');
  fixture.session('wrong-native', fixture.unrelated, saved.record.nativeSessionFile);
  const current = { file: fixture.root, id: 'root', sessionDirectory: fixture.sessions };
  const history = await searchHistory(fixture.workers, current, 'worker-aa');

  expect(history.candidates).toHaveLength(1);
  expect(history.candidates[0]).toMatchObject({ taskId: 'first', nativeEvidence: 'invalid' });
  expect(history.diagnostics.length).toBeGreaterThan(0);
});

it('carries derived state for generic task candidates without inventing native sessions', async () => {
  const fixture = setup();
  const taskDirectory = join(fixture.workers, 'generic-one');
  mkdirSync(taskDirectory);
  const record = validateTask({
    version: 2,
    taskId: 'generic-one',
    task: 'Inspect shared source.',
    parentSession: fixture.child,
    parentSessionId: 'child',
    createdAt: 1000,
    deadline: 20000,
    cancellationBudget: 1000,
    monotonicDeadline: 20000,
    loadout: fixtureGenericLoadout(fixture.directory),
  });
  publish(taskDirectory, 'task.json', record);
  recordEvent(taskDirectory, 'generic-one', 'cleanup', { detail: 'Pane removed.', stopped: true });

  const history = await searchHistory(fixture.workers, {
    file: fixture.root,
    id: 'root',
    sessionDirectory: fixture.sessions,
  });
  const candidate = history.candidates.find((entry) => entry.taskId === 'generic-one');

  expect(candidate).toMatchObject({ state: 'stopped', nativeEvidence: 'opaque' });
  expect(candidate).not.toHaveProperty('nativeSessionId');
  expect(candidate).not.toHaveProperty('nativeSessionFile');
});

it('derives candidate state with ownership from the live controller', async () => {
  const fixture = setup();
  const saved = fixture.task('owned', fixture.child, 'child', 'worker-aa');
  rmSync(join(saved.taskDirectory, 'cleanup.json'));
  const current = { file: fixture.root, id: 'root', sessionDirectory: fixture.sessions };

  const untracked = await searchHistory(fixture.workers, current, 'worker-aa');
  const owned = await searchHistory(
    fixture.workers,
    current,
    'worker-aa',
    (taskId) => taskId === 'owned',
  );

  expect(untracked.candidates[0]?.state).toBe('cleanupUnconfirmed');
  expect(owned.candidates[0]?.state).toBe('reported');
});

it('diagnoses discovered metadata that disagrees with a seeded ancestor identity', async () => {
  const fixture = setup();
  const [discovered] = await SessionManager.listAll(fixture.sessions);
  vi.spyOn(SessionManager, 'listAll').mockResolvedValue([
    { ...discovered, path: fixture.root, id: 'impostor' } as SessionInfo,
  ]);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  const history = await searchHistory(fixture.workers, {
    file: fixture.child,
    id: 'child',
    sessionDirectory: fixture.sessions,
  });

  expect(history.diagnostics).toContain(
    'Discovered metadata disagrees with a validated session identity.',
  );
  expect(history.candidates.some((candidate) => candidate.nativeSessionId === 'impostor')).toBe(
    false,
  );
});
