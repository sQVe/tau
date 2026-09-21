import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { WorkerController } from './controller.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { searchHistory } from './history.js';
import subagentsExtension from './index.js';
import { acceptReport, publish, readTask, recordEvent, validateTask } from './records.js';
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
  const workers = join(directory, 'tau', 'workers');
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
      ownerId: 'owner',
      nativeSessionId,
      nativeSessionFile,
      createdAt: 1000,
      deadline: 20000,
      cancellationBudget: 1000,
      tree: {
        rootSession: parentSession,
        rootSessionId: parentSessionId,
        monotonicDeadline: 20000,
      },
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
      sourceFile: string;
      description: string;
      truncatedFields: string[];
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
  const source = page.candidates[0]?.sourceFile ?? '';
  expect(readFileSync(source, 'utf8')).toContain('needle-tail');
  expect(readFileSync(join(dirname(source), 'report.json'), 'utf8')).toContain('界'.repeat(10000));
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
  expect(last.details).toMatchObject({
    totalMatches: 20,
    nextOffset: null,
    candidates: [
      expect.objectContaining({ taskId: 'task-18' }),
      expect.objectContaining({ taskId: 'task-19' }),
    ],
  });
  const second = await execute({ query: 'needle-tail', offset: page.nextOffset, limit: 1 });
  expect(JSON.stringify(second)).toContain('task-01');
  const empty = await execute({ query: 'needle-tail', offset: 20 });
  expect(empty.details).toMatchObject({
    outcome: 'clarification',
    totalMatches: 20,
    candidates: [],
    nextOffset: null,
  });
});

it('includes explicit custom-extension current and root sessions in the production history tool', async () => {
  const fixture = setup();
  const root = fixture.session('explicit-root', undefined, join(fixture.sessions, 'root.session'));
  const current = fixture.session(
    'explicit-current',
    root,
    join(fixture.sessions, 'current.session'),
  );
  const execute = await historyTool(fixture, current, 'explicit-current');
  const result = await execute({ query: 'explicit-' });

  expect(result.details).toMatchObject({
    outcome: 'clarification',
    candidates: [
      expect.objectContaining({ nativeSessionId: 'explicit-current' }),
      expect.objectContaining({ nativeSessionId: 'explicit-root' }),
    ],
  });
  const fromRoot = await historyTool(fixture, root, 'explicit-root');
  const rootResult = await fromRoot({ query: 'explicit-root' });
  expect(rootResult.details).toMatchObject({
    outcome: 'match',
    candidates: [expect.objectContaining({ nativeSessionId: 'explicit-root' })],
  });
});

it('merges discovered native metadata into seeded history without duplicate candidates', async () => {
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

  expect(result.details).toMatchObject({
    outcome: 'match',
    totalMatches: 1,
    candidates: [
      expect.objectContaining({
        name: 'Named root',
        description: 'Native description.',
        nativeSessionId: 'root',
        sourceFile: fixture.root,
      }),
    ],
  });
});

it('reports corrupt saved reports and claims as diagnostics without hiding other tasks', async () => {
  const fixture = setup();
  const corruptReport = fixture.task('corrupt-report', fixture.child, 'child');
  const corruptClaim = fixture.task('corrupt-claim', fixture.child, 'child');
  fixture.task('intact', fixture.child, 'child');
  writeFileSync(join(corruptReport.taskDirectory, 'report.json'), '{}');
  writeFileSync(join(corruptClaim.taskDirectory, 'successor.json'), '{}');

  const history = await searchHistory(fixture.workers, {
    file: fixture.child,
    id: 'child',
    sessionDirectory: fixture.sessions,
  });

  expect(
    history.candidates
      .flatMap((candidate) => (candidate.taskId ? [candidate.taskId] : []))
      .toSorted(),
  ).toEqual(['corrupt-claim', 'corrupt-report', 'intact']);
  expect(
    history.candidates.find((candidate) => candidate.taskId === 'corrupt-report'),
  ).not.toHaveProperty('report');
  expect(history.diagnostics.join(' ')).toContain('Task corrupt-report');
  expect(history.diagnostics.join(' ')).toContain('Task corrupt-claim');
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
  expect(history.candidates.map((candidate) => candidate.nativeSessionId)).toEqual(
    expect.arrayContaining(['root', 'child', 'sibling', nested.record.nativeSessionId]),
  );
  expect(history.candidates.find((candidate) => candidate.taskId === 'first')).toMatchObject({
    name: 'worker-aa',
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
  expect(fromRoot.candidates).toEqual(history.candidates);
  expect(history.candidates.some((candidate) => candidate.nativeSessionId === 'unrelated')).toBe(
    false,
  );
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
  ).toEqual(['child', 'root', 'sibling']);
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
