import * as fileSystem from 'node:fs';
import {
  fstatSync,
  fsyncSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished as afterTest, vi } from 'vitest';

import { fixtureGenericLoadout } from './fixtures/loadout.js';
import * as questions from './questionRecords.js';
import * as records from './records.js';
import { workerState } from './workerState.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fileSystem>();

  return {
    ...original,
    fsyncSync: vi.fn<typeof fsyncSync>(original.fsyncSync),
    readSync: vi.fn<typeof original.readSync>(original.readSync),
    openSync: vi.fn<typeof original.openSync>(original.openSync),
    closeSync: vi.fn<typeof original.closeSync>(original.closeSync),
    statSync: vi.fn<typeof original.statSync>(original.statSync),
    lstatSync: vi.fn<typeof original.lstatSync>(original.lstatSync),
    readdirSync: vi.fn<typeof original.readdirSync>(original.readdirSync),
  };
});

afterEach(() => vi.resetAllMocks());

const questionFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-questions-'));
  afterTest(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const task = {
    version: 1,
    taskId: 'task-one',
    task: 'Inspect source.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent-one',
    ownerId: 'owner-one',
    nativeSessionId: 'native-one',
    nativeSessionFile: join(directory, 'native.jsonl'),
    createdAt: 1000,
    deadline: 20000,
    cancellationBudget: 1000,
    tree: {
      rootSession: join(directory, 'parent.jsonl'),
      rootSessionId: 'parent-one',
      monotonicDeadline: 20000,
    },
    loadout: {
      harness: 'pi',
      profile: 'investigator',
      role: 'investigation',
      model: 'faux/test',
      modelFingerprint: '0'.repeat(64),
      providerFingerprint: '0'.repeat(64),
      providerFingerprintVersion: 2,
      thinking: 'off',
      cwd: directory,
      agentDirectory: directory,
      permissions: 'trusted-full-tools',
      tools: ['read', 'bash', 'edit', 'write', 'subagent_report', 'subagent_question'],
      noExtensions: false,
      integrations: [join(directory, 'safety.js')],
      integrationFingerprint: '0'.repeat(64),
      safetyExtension: join(directory, 'safety.js'),
      instructions: 'Inspect the assigned source.',
    },
  };
  const question = {
    version: 1,
    taskId: task.taskId,
    questionId: 'question-one',
    question: 'Which source file?',
  };
  const reply = {
    version: 1,
    taskId: task.taskId,
    questionId: question.questionId,
    replyId: 'reply-one',
    reply: 'Inspect source.ts.',
  };
  const acknowledgement = {
    version: 1,
    taskId: task.taskId,
    questionId: question.questionId,
    replyId: reply.replyId,
  };
  records.publish(directory, 'task.json', task);

  return { directory, task, question, reply, acknowledgement };
};

it.each([
  'malformed',
  'permission',
  'identity',
  'accepted',
  'claim',
  'report',
  'dangling task link',
] as const)('keeps task scans fail closed for %s evidence', (failure) => {
  const { directory, task } = questionFixture();
  const root = join(directory, 'registry');
  const child = join(root, task.taskId);
  mkdirSync(child, { recursive: true });
  records.publish(child, 'task.json', task);

  if (failure === 'malformed') {
    writeFileSync(join(child, 'task.json'), '{');
  } else if (failure === 'permission') {
    vi.mocked(fileSystem.openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Permission denied.'), { code: 'EACCES' });
    });
  } else if (failure === 'identity') {
    writeFileSync(join(child, 'task.json'), JSON.stringify({ ...task, taskId: 'changed' }));
  } else {
    rmSync(join(child, 'task.json'));

    if (failure === 'dangling task link') {
      symlinkSync(join(child, 'missing'), join(child, 'task.json'));
    } else {
      const marker = failure === 'claim' ? 'successor.json' : `${failure}.json`;
      writeFileSync(join(child, marker), '{}');
    }
  }

  expect(() => records.readTasks(root)).toThrow(/JSON|property|Permission|identity|task.json/);
});

it('skips tasks saved in a retired format without blocking current tasks', () => {
  const { directory, task } = questionFixture();
  const root = join(directory, 'registry');
  const current = join(root, task.taskId);
  mkdirSync(current, { recursive: true });
  records.publish(current, 'task.json', task);
  const { harness: _harness, ...unversioned } = task.loadout;
  const retired = {
    unversioned: { ...task, taskId: 'unversioned', loadout: unversioned },
    claude: { ...task, taskId: 'claude', loadout: { ...task.loadout, harness: 'claude' } },
    'fingerprint-one': {
      ...task,
      taskId: 'fingerprint-one',
      loadout: { ...task.loadout, providerFingerprintVersion: 1 },
    },
  };

  for (const [taskId, saved] of Object.entries(retired)) {
    mkdirSync(join(root, taskId));
    writeFileSync(join(root, taskId, 'task.json'), JSON.stringify(saved));
  }

  const diagnostics: string[] = [];

  const scanned = records.readTasks(root, diagnostics);

  expect(scanned).toEqual([{ directory: current, task }]);
  expect(diagnostics.toSorted()).toEqual(
    ['claude', 'fingerprint-one', 'unversioned'].map(
      (taskId) => `Skipped task ${taskId} saved in a retired format; start a fresh task instead.`,
    ),
  );
});

it('fails a scan for an invalid task saved in the current format', () => {
  const { directory, task } = questionFixture();
  const root = join(directory, 'registry');
  const child = join(root, task.taskId);
  mkdirSync(child, { recursive: true });
  writeFileSync(
    join(child, 'task.json'),
    JSON.stringify({ ...task, loadout: { ...task.loadout, tools: ['read'] } }),
  );

  expect(() => records.readTasks(root)).toThrow('coding and report tools');
});

it('fails a scan for a generic task saved without its tree', () => {
  const { directory, task } = questionFixture();
  const root = join(directory, 'registry');
  const child = join(root, task.taskId);
  mkdirSync(child, { recursive: true });
  const { tree: _tree, ...treeLess } = task;
  writeFileSync(
    join(child, 'task.json'),
    JSON.stringify({ ...treeLess, loadout: { harness: 'generic', kind: 'codex' } }),
  );

  expect(() => records.readTasks(root)).toThrow('Invalid saved worker task or loadout');
});

it('reads a task published by another process during the scan', () => {
  const { directory, task } = questionFixture();
  const root = join(directory, 'registry');
  const child = join(root, task.taskId);
  mkdirSync(child, { recursive: true });
  records.publish(child, 'task.json', task);
  vi.mocked(fileSystem.openSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('Not yet published.'), { code: 'ENOENT' });
  });

  expect(records.readTasks(root)).toEqual([{ directory: child, task }]);
});

it.each([
  { successor: 'published late', result: ['predecessor', 'successor', 'task-one'] },
  {
    successor: 'still unpublished',
    result:
      'Error: Missing task.json for referenced continuation successor. Saved attempt or claim requires inspection.',
  },
])(
  'checks every late continuation reference when the successor is $successor',
  async ({ successor: state, result }) => {
    const { directory, task } = questionFixture();
    const root = join(directory, 'registry');
    const directories = {
      middle: join(root, task.taskId),
      predecessor: join(root, 'predecessor'),
      successor: join(root, 'successor'),
    };

    for (const path of Object.values(directories)) {
      mkdirSync(path, { recursive: true });
    }

    const middle = records.validateTask({ ...task, predecessorTaskId: 'predecessor' });
    const successor = records.validateTask({
      ...task,
      taskId: 'successor',
      predecessorTaskId: task.taskId,
    });
    records.publish(directories.middle, 'task.json', middle);
    records.publish(directories.predecessor, 'task.json', { ...task, taskId: 'predecessor' });

    if (state === 'published late') {
      records.publish(directories.successor, 'task.json', successor);
    }

    records.claimSuccessor(directories.middle, successor);
    const original = await vi.importActual<typeof fileSystem>('node:fs');
    // Each continuation looks unpublished until the scan lists its directory, then another process publishes it.
    const hidden = new Set([directories.predecessor, directories.successor]);
    const isHidden = (path: unknown) =>
      [...hidden].some((hiddenDirectory) => path === join(hiddenDirectory, 'task.json'));
    vi.mocked(fileSystem.openSync).mockImplementation((path, ...rest) => {
      if (isHidden(path)) {
        throw Object.assign(new Error('Not yet published.'), { code: 'ENOENT' });
      }

      return original.openSync(path, ...rest);
    });
    vi.mocked(fileSystem.lstatSync).mockImplementation(((path: string, options: object) =>
      isHidden(path)
        ? undefined
        : original.lstatSync(path, options)) as typeof fileSystem.lstatSync);
    vi.mocked(fileSystem.readdirSync).mockImplementation(((path: string, options: object) => {
      if (typeof path === 'string' && hidden.delete(path)) {
        return [];
      }

      return original.readdirSync(path, options);
    }) as typeof fileSystem.readdirSync);

    const scan = () => {
      try {
        return records
          .readTasks(root)
          .map((entry) => entry.task.taskId)
          .toSorted();
      } catch (error) {
        return String(error);
      }
    };

    expect(scan()).toEqual(result);
  },
);

it('reads the saved task once while finding the pending question', () => {
  const { directory, task, question, reply, acknowledgement } = questionFixture();
  const pending = { ...question, questionId: 'question-two' };
  questions.acceptQuestion(directory, task.taskId, question);
  questions.acceptReply(directory, task.taskId, reply);
  questions.acceptAcknowledgement(directory, task.taskId, acknowledgement);
  questions.acceptQuestion(directory, task.taskId, pending);
  vi.mocked(fileSystem.openSync).mockClear();

  expect(questions.readPendingQuestion(directory, task.taskId)).toEqual(pending);
  const taskReads = vi
    .mocked(fileSystem.openSync)
    .mock.calls.filter(([path]) => String(path).endsWith('task.json'));
  expect(taskReads).toHaveLength(1);
});

it.each(['claim', 'predecessor'] as const)(
  'does not skip an unpublished directory referenced by a published %s',
  (reference) => {
    const { directory, task } = questionFixture();
    const root = join(directory, 'registry');
    const source = join(root, task.taskId);
    const pending = join(root, 'unpublished');
    mkdirSync(source, { recursive: true });
    mkdirSync(pending);
    records.publish(source, 'task.json', {
      ...task,
      ...(reference === 'predecessor' ? { predecessorTaskId: 'unpublished' } : {}),
    });

    if (reference === 'claim') {
      records.claimSuccessor(
        source,
        records.validateTask({ ...task, taskId: 'unpublished', predecessorTaskId: task.taskId }),
      );
    }

    expect(() => records.readTasks(root)).toThrow('referenced continuation unpublished');
    expect(readdirSync(pending)).toEqual([]);
  },
);

it('retains an exclusive successor claim after directory sync uncertainty and never republishes it', async () => {
  const { directory, task } = questionFixture();
  const successor = records.validateTask({
    ...task,
    taskId: 'successor',
    predecessorTaskId: task.taskId,
  });
  const original = await vi.importActual<typeof fileSystem>('node:fs');
  vi.mocked(fsyncSync).mockImplementation((descriptor) => {
    if (fstatSync(descriptor).isDirectory()) {
      throw new Error('Directory sync failed.');
    }

    original.fsyncSync(descriptor);
  });
  expect(() => {
    records.claimSuccessor(directory, successor);
  }).toThrow('successor');
  const bytes = readFileSync(join(directory, 'successor.json'));
  expect(records.readSuccessor(directory)?.successorTaskId).toBe('successor');
  vi.mocked(fsyncSync).mockImplementation(original.fsyncSync);

  expect(() => {
    records.claimSuccessor(directory, successor);
  }).toThrow('already claimed');
  expect(readFileSync(join(directory, 'successor.json'))).toEqual(bytes);
});

it('requires directory sync on identical question reply and acknowledgement recovery', async () => {
  const { directory, task, question, reply, acknowledgement } = questionFixture();
  const original = await vi.importActual<typeof fileSystem>('node:fs');
  const syncFailure = Object.assign(new Error('Directory sync failed.'), { code: 'EIO' });
  let failDirectorySync = true;
  let directorySyncAttempts = 0;
  vi.mocked(fsyncSync).mockImplementation((descriptor) => {
    if (fstatSync(descriptor).isDirectory()) {
      directorySyncAttempts += 1;

      if (failDirectorySync) {
        throw syncFailure;
      }
    }

    original.fsyncSync(descriptor);
  });
  afterTest(() => {
    vi.mocked(fsyncSync).mockImplementation(original.fsyncSync);
  });
  const submissions = [
    ['question', question, () => questions.acceptQuestion(directory, task.taskId, question)],
    ['reply', reply, () => questions.acceptReply(directory, task.taskId, reply)],
    [
      'acknowledgement',
      acknowledgement,
      () => questions.acceptAcknowledgement(directory, task.taskId, acknowledgement),
    ],
  ] as const;

  for (const [kind, value, accept] of submissions) {
    failDirectorySync = true;
    directorySyncAttempts = 0;
    expect(accept).toThrow(syncFailure);
    expect(directorySyncAttempts).toBe(1);
    const path = join(directory, `${kind}-${question.questionId}.json`);
    const saved = readFileSync(path, 'utf8');
    const inode = statSync(path).ino;
    expect(JSON.parse(saved)).toEqual(value);

    expect(accept).toThrow(syncFailure);
    expect(directorySyncAttempts).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(statSync(path).ino).toBe(inode);

    failDirectorySync = false;
    expect(accept()).toEqual(value);
    expect(directorySyncAttempts).toBe(3);
    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(statSync(path).ino).toBe(inode);
  }
});

it('recovers immutable questions and replies separately from worker acknowledgement', () => {
  const { directory, task, question, reply, acknowledgement } = questionFixture();
  const originalTask = readFileSync(join(directory, 'task.json'), 'utf8');

  expect(questions).toHaveProperty('acceptQuestion');
  expect(questions.readQuestion(directory, task.taskId, question.questionId)).toBeUndefined();
  expect(questions.acceptQuestion(directory, task.taskId, question)).toEqual(question);
  expect(questions.acceptQuestion(directory, task.taskId, { ...question })).toEqual(question);
  expect(questions.readReply(directory, task.taskId, question.questionId)).toBeUndefined();
  expect(questions.acceptReply(directory, task.taskId, reply)).toEqual(reply);
  expect(questions.acceptReply(directory, task.taskId, { ...reply })).toEqual(reply);
  expect(
    questions.readAcknowledgement(directory, task.taskId, question.questionId),
  ).toBeUndefined();
  expect(questions.acceptAcknowledgement(directory, task.taskId, acknowledgement)).toEqual(
    acknowledgement,
  );
  expect(questions.acceptAcknowledgement(directory, task.taskId, { ...acknowledgement })).toEqual(
    acknowledgement,
  );

  expect(questions.readQuestion(directory, task.taskId, question.questionId)).toEqual(question);
  expect(questions.readReply(directory, task.taskId, question.questionId)).toEqual(reply);
  expect(questions.readAcknowledgement(directory, task.taskId, question.questionId)).toEqual(
    acknowledgement,
  );
  const saved = readdirSync(directory).map(
    (name) => [name, readFileSync(join(directory, name), 'utf8')] as const,
  );
  questions.acceptQuestion(directory, task.taskId, {
    question: question.question,
    questionId: question.questionId,
    taskId: task.taskId,
    version: 1,
  });
  questions.acceptReply(directory, task.taskId, reply);
  questions.acceptAcknowledgement(directory, task.taskId, acknowledgement);

  for (const [name, content] of saved) {
    expect(readFileSync(join(directory, name), 'utf8')).toBe(content);
  }

  const secondQuestion = { ...question, questionId: 'question-two' };
  questions.acceptQuestion(directory, task.taskId, secondQuestion);
  expect(questions.readReply(directory, task.taskId, secondQuestion.questionId)).toBeUndefined();
  expect(
    questions.readAcknowledgement(directory, task.taskId, secondQuestion.questionId),
  ).toBeUndefined();
  expect(readFileSync(join(directory, 'task.json'), 'utf8')).toBe(originalTask);
  expect(records.readTask(directory)).toEqual(task);
});

it('rejects wrong-task malformed mismatched and conflicting question records', () => {
  const { directory, task, question, reply, acknowledgement } = questionFixture();

  expect(questions).toHaveProperty('acceptQuestion');
  expect(() => questions.acceptReply(directory, task.taskId, reply)).toThrow(
    'Reply has no accepted question.',
  );
  expect(() => questions.acceptAcknowledgement(directory, task.taskId, acknowledgement)).toThrow(
    'Acknowledgement does not match the accepted reply.',
  );

  for (const invalid of [
    { ...question, taskId: 'wrong' },
    { ...question, questionId: '../escape' },
    { ...question, question: '' },
    { ...question, version: 2 },
    { ...question, deadline: 999999 },
    { ...question, question: '界'.repeat(32000) },
  ]) {
    expect(() => questions.acceptQuestion(directory, task.taskId, invalid)).toThrow(
      /Invalid|exceeds/,
    );
  }

  expect(() =>
    questions.acceptQuestion(directory, 'wrong', { ...question, taskId: 'wrong' }),
  ).toThrow('wrong saved task');
  questions.acceptQuestion(directory, task.taskId, question);
  expect(() =>
    questions.acceptQuestion(directory, task.taskId, { ...question, question: 'Changed?' }),
  ).toThrow('Conflicting saved question record.');
  expect(() => questions.acceptAcknowledgement(directory, task.taskId, acknowledgement)).toThrow(
    'Acknowledgement does not match the accepted reply.',
  );

  for (const invalid of [
    { ...reply, questionId: 'missing' },
    { ...reply, taskId: 'wrong' },
    { ...reply, reply: '' },
    { ...reply, replyId: '../escape' },
    { ...reply, extra: true },
    { ...reply, reply: '界'.repeat(32000) },
  ]) {
    expect(() => questions.acceptReply(directory, task.taskId, invalid)).toThrow(
      /Invalid|exceeds|no accepted question/,
    );
  }

  questions.acceptReply(directory, task.taskId, reply);
  expect(() =>
    questions.acceptReply(directory, task.taskId, { ...reply, replyId: 'reply-two' }),
  ).toThrow('Conflicting saved question record.');
  expect(() =>
    questions.acceptReply(directory, task.taskId, { ...reply, reply: 'Changed.' }),
  ).toThrow('Conflicting saved question record.');

  for (const invalid of [
    { ...acknowledgement, replyId: 'reply-two' },
    { ...acknowledgement, questionId: 'missing' },
    { ...acknowledgement, taskId: 'wrong' },
    { ...acknowledgement, applied: true },
  ]) {
    expect(() => questions.acceptAcknowledgement(directory, task.taskId, invalid)).toThrow(
      /Invalid|does not match/,
    );
  }

  expect(questions.readQuestion(directory, task.taskId, question.questionId)).toEqual(question);
  expect(questions.readReply(directory, task.taskId, question.questionId)).toEqual(reply);
  expect(
    questions.readAcknowledgement(directory, task.taskId, question.questionId),
  ).toBeUndefined();
});

it('validates saved question reply and acknowledgement chains during recovery', () => {
  const { directory, task, question, reply, acknowledgement } = questionFixture();

  expect(questions).toHaveProperty('acceptQuestion');
  questions.acceptQuestion(directory, task.taskId, question);
  questions.acceptReply(directory, task.taskId, reply);
  questions.acceptAcknowledgement(directory, task.taskId, acknowledgement);
  const files = [
    [
      'question',
      question,
      () => questions.readQuestion(directory, task.taskId, question.questionId),
    ],
    ['reply', reply, () => questions.readReply(directory, task.taskId, question.questionId)],
    [
      'acknowledgement',
      acknowledgement,
      () => questions.readAcknowledgement(directory, task.taskId, question.questionId),
    ],
  ] as const;

  for (const [kind, value, recover] of files) {
    const path = join(directory, `${kind}-${question.questionId}.json`);

    for (const invalid of [
      { ...value, taskId: 'wrong' },
      { ...value, questionId: 'wrong' },
      { ...value, extra: true },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      expect(recover).toThrow('Invalid saved worker');
      expect(() =>
        questions.readAcknowledgement(directory, task.taskId, question.questionId),
      ).toThrow('Invalid saved worker');
    }

    writeFileSync(path, '{');
    expect(recover).toThrow(SyntaxError);
    writeFileSync(path, JSON.stringify(value));
  }

  for (const [kind, value, recover] of files.slice(0, 2)) {
    const path = join(directory, `${kind}-${question.questionId}.json`);
    writeFileSync(path, JSON.stringify({ ...value, [kind]: '界'.repeat(32000) }));
    expect(recover).toThrow('Invalid saved worker');
    rmSync(path);
    expect(() =>
      questions.readAcknowledgement(directory, task.taskId, question.questionId),
    ).toThrow('Invalid saved worker');
    writeFileSync(path, JSON.stringify(value));
  }

  writeFileSync(
    join(directory, `acknowledgement-${question.questionId}.json`),
    JSON.stringify({ ...acknowledgement, replyId: 'wrong' }),
  );
  expect(() => questions.readAcknowledgement(directory, task.taskId, question.questionId)).toThrow(
    'Invalid saved worker acknowledgement.',
  );
  expect(() => questions.readQuestion(directory, task.taskId, '../escape')).toThrow(
    'Invalid question identity',
  );
  expect(() => questions.readQuestion(directory, 'wrong', question.questionId)).toThrow(
    'wrong saved task',
  );
});

it('bounds serialized UTF-8 records including the trailing newline before publication', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const value = { text: '界'.repeat(42_660) };
  value.text += 'x'.repeat(128_000 - Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8'));

  records.publish(directory, 'record.json', value);
  expect(records.readRecord(directory, 'record.json')).toEqual(value);
  expect(readFileSync(join(directory, 'record.json'))).toHaveLength(128_000);
  expect(() => {
    records.publish(directory, 'oversized.json', { text: `${value.text}x` });
  }).toThrow('Worker record exceeds 128 KB.');
  expect(readdirSync(directory)).toEqual(['record.json']);
  expect(records.readRecord(directory, 'record.json')).toEqual(value);
});

it('reads records across short descriptor reads', async ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  onTestFinished(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, 'record.json'), '{"text":"short read"}');
  const actual = await vi.importActual<typeof fileSystem>('node:fs');
  vi.mocked(fileSystem.readSync).mockImplementation((descriptor, buffer, options) => {
    return actual.readSync(descriptor, buffer, {
      ...options,
      length: Math.min(3, options?.length ?? buffer.byteLength),
    });
  });

  expect(records.readRecord(directory, 'record.json')).toEqual({ text: 'short read' });
  expect(fileSystem.readSync).toHaveBeenCalledTimes(8);
  expect(fileSystem.closeSync).toHaveBeenCalledWith(
    vi.mocked(fileSystem.openSync).mock.results.at(-1)?.value,
  );
});

it('bounds descriptor reads when a record grows during reading', async ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  onTestFinished(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'record.json');
  writeFileSync(path, '{"text":"small"}');
  const actual = await vi.importActual<typeof fileSystem>('node:fs');
  const grow = () => {
    writeFileSync(path, JSON.stringify({ text: 'x'.repeat(256_000) }));
  };
  vi.mocked(fileSystem.statSync).mockImplementationOnce((...argumentsList) => {
    const result = actual.statSync(...argumentsList);
    grow();

    return result;
  });
  let totalRead = 0;
  vi.mocked(fileSystem.readSync).mockImplementation((descriptor, buffer, options) => {
    const count = actual.readSync(descriptor, buffer, {
      ...options,
      length: Math.min(64_000, options?.length ?? buffer.byteLength),
    });

    if (totalRead === 0) {
      grow();
    }

    totalRead += count;

    return count;
  });

  expect(() => records.readRecord(directory, 'record.json')).toThrow(
    'Worker record exceeds 128 KB.',
  );
  expect(totalRead).toBe(128_001);
  expect(fileSystem.openSync).toHaveBeenCalledTimes(1);
  expect(fileSystem.closeSync).toHaveBeenCalledWith(
    vi.mocked(fileSystem.openSync).mock.results[0]?.value,
  );
});

it.each(['invalid JSON', 'read failure'])('closes the record descriptor after %s', (failure) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  afterTest(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, 'record.json'), '{');

  if (failure === 'read failure') {
    vi.mocked(fileSystem.readSync).mockImplementationOnce(() => {
      throw new Error('Injected read failure');
    });
  }

  expect(() => records.readRecord(directory, 'record.json')).toThrow(
    failure === 'read failure' ? 'Injected read failure' : /JSON|property/,
  );
  expect(fileSystem.closeSync).toHaveBeenCalledWith(
    vi.mocked(fileSystem.openSync).mock.results[0]?.value,
  );
});

it('keeps report and event publication within their existing byte limits', ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const report = {
    taskId: 'task-one',
    outcome: 'success',
    summary: '界'.repeat(32_000),
    evidence: [],
  };

  expect(() => records.acceptReport(directory, 'task-one', report)).toThrow(
    'Invalid, oversized, or wrong-task report.',
  );
  expect(() => {
    records.recordEvent(directory, '界'.repeat(32_000), 'ready', '界'.repeat(32_000));
  }).toThrow('Worker record exceeds 128 KB.');
  expect(readdirSync(directory)).toEqual([]);

  const accepted = { ...report, summary: '界'.repeat(10_000) };
  records.acceptReport(directory, 'task-one', accepted);
  records.recordEvent(directory, 'task-one', 'ready', accepted.summary);
  expect(records.readReport(directory, 'task-one')).toEqual(accepted);
  expect(records.readEvent(directory, 'task-one', 'ready')?.detail).toBe(accepted.summary);
});

it('rejects oversized Unicode reports during recovery without replacing evidence', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-report-recovery-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const report = {
    taskId: 'task-one',
    outcome: 'success',
    summary: '界'.repeat(22_000),
    evidence: [],
  };
  records.publish(directory, 'report.json', report);
  const original = readFileSync(join(directory, 'report.json'), 'utf8');

  expect(Buffer.byteLength(original)).toBeGreaterThan(64_000);
  expect(Buffer.byteLength(original)).toBeLessThan(128_000);
  expect(() => records.readReport(directory, 'task-one')).toThrow('Invalid saved worker report.');
  expect(readFileSync(join(directory, 'report.json'), 'utf8')).toBe(original);
});

it('accepts one validated report without replacing durable evidence', ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-records-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const report = {
    taskId: 'task-one',
    outcome: 'success',
    summary: 'Checked source.',
    evidence: ['source.ts:1'],
  };

  expect(records).toHaveProperty('acceptReport');
  records.acceptReport(directory, 'task-one', report);
  const accepted = readFileSync(join(directory, 'report.json'), 'utf8');

  expect(() => records.acceptReport(directory, 'task-one', report)).toThrow('EEXIST');
  expect(() => records.acceptReport(directory, 'task-one', { ...report, taskId: 'wrong' })).toThrow(
    'Invalid',
  );
  expect(() => records.acceptReport(directory, 'task-one', { taskId: 'task-one' })).toThrow(
    'Invalid',
  );
  expect(() =>
    records.acceptReport(directory, 'task-one', { ...report, summary: 'x'.repeat(40_000) }),
  ).toThrow('Invalid');
  expect(readFileSync(join(directory, 'report.json'), 'utf8')).toBe(accepted);
});

const genericWorkerFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-generic-'));
  afterTest(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const task = {
    version: 2,
    taskId: 'task-two',
    task: 'Inspect source.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent-two',
    ownerId: 'owner-one',
    createdAt: 1000,
    deadline: 20000,
    cancellationBudget: 1000,
    tree: {
      rootSession: join(directory, 'root.jsonl'),
      rootSessionId: 'root-two',
      monotonicDeadline: 20000,
    },
    loadout: fixtureGenericLoadout(directory),
  };
  records.publish(directory, 'task.json', task);

  return { directory, task };
};

it.each([
  { harness: 'pi', records: ['ready'], owner: 'owner-one', enforcing: true, state: 'starting' },
  {
    harness: 'pi',
    records: ['ready', 'accepted'],
    owner: 'owner-one',
    enforcing: true,
    state: 'running',
  },
  {
    harness: 'pi',
    records: ['accepted', 'question'],
    owner: 'owner-one',
    enforcing: true,
    state: 'awaitingReply',
  },
  {
    harness: 'pi',
    records: ['accepted', 'question', 'reply'],
    owner: 'owner-one',
    enforcing: true,
    state: 'running',
  },
  {
    harness: 'pi',
    records: ['accepted', 'report'],
    owner: 'owner-one',
    enforcing: true,
    state: 'reported',
  },
  {
    harness: 'pi',
    records: ['accepted', 'report'],
    owner: 'owner-one',
    enforcing: false,
    state: 'stopping',
  },
  {
    harness: 'pi',
    records: ['accepted', 'report', 'stopping'],
    owner: 'owner-one',
    enforcing: true,
    state: 'stopping',
  },
  {
    harness: 'pi',
    records: ['accepted', 'stopping'],
    owner: undefined,
    enforcing: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    records: ['accepted', 'report'],
    owner: undefined,
    enforcing: true,
    state: 'notOwned',
  },
  {
    harness: 'pi',
    records: ['accepted', 'report', 'cleanupStopped'],
    owner: 'owner-one',
    enforcing: true,
    state: 'stopped',
  },
  {
    harness: 'pi',
    records: ['accepted', 'settledStopped'],
    owner: undefined,
    enforcing: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    records: ['accepted', 'settled'],
    owner: 'owner-one',
    enforcing: true,
    state: 'running',
  },
  {
    harness: 'pi',
    records: ['accepted', 'startupFailure'],
    owner: 'other-owner',
    enforcing: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    records: ['accepted', 'timeoutStopped'],
    owner: undefined,
    enforcing: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    records: ['accepted', 'timeout'],
    owner: 'owner-one',
    enforcing: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    records: ['accepted', 'cancelled'],
    owner: 'owner-one',
    enforcing: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'pi',
    records: ['accepted', 'cleanup'],
    owner: 'owner-one',
    enforcing: false,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'generic',
    records: ['ready'],
    owner: 'owner-one',
    enforcing: true,
    state: 'starting',
  },
  {
    harness: 'generic',
    records: ['assignment'],
    owner: 'owner-one',
    enforcing: true,
    state: 'running',
  },
  {
    harness: 'generic',
    records: ['assignmentUncertain'],
    owner: 'owner-one',
    enforcing: true,
    state: 'starting',
  },
  {
    harness: 'generic',
    records: ['assignment', 'report'],
    owner: 'owner-one',
    enforcing: true,
    state: 'reported',
  },
  {
    harness: 'generic',
    records: ['assignment', 'report'],
    owner: 'owner-one',
    enforcing: false,
    state: 'stopping',
  },
  {
    harness: 'generic',
    records: ['assignment', 'report'],
    owner: undefined,
    enforcing: true,
    state: 'notOwned',
  },
  {
    harness: 'generic',
    records: ['assignment', 'settledStopped'],
    owner: undefined,
    enforcing: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'generic',
    records: ['assignment', 'timeoutStopped'],
    owner: undefined,
    enforcing: true,
    state: 'cleanupUnconfirmed',
  },
  {
    harness: 'generic',
    records: ['assignment', 'stopping'],
    owner: 'owner-one',
    enforcing: true,
    state: 'stopping',
  },
  {
    harness: 'generic',
    records: ['assignment', 'cleanupStopped'],
    owner: undefined,
    enforcing: true,
    state: 'stopped',
  },
])(
  'derives $state from $records for $harness owner $owner',
  ({ harness, records: saved, owner, enforcing, state }) => {
    const { directory, task } = harness === 'pi' ? questionFixture() : genericWorkerFixture();
    const publishAssignment = (observationState: string) => {
      records.publish(directory, records.submissionName('assignment', 'intent'), {
        taskId: task.taskId,
        id: 'assignment',
        text: 'Work.',
      });
      records.publish(directory, records.submissionName('assignment', 'observation'), {
        taskId: task.taskId,
        id: 'assignment',
        state: observationState,
        detail: 'Saved.',
      });
    };
    const write: Record<string, () => void> = {
      question: () =>
        questions.acceptQuestion(directory, task.taskId, {
          version: 1,
          taskId: task.taskId,
          questionId: 'question-one',
          question: 'Which source file?',
        }),
      reply: () =>
        questions.acceptReply(directory, task.taskId, {
          version: 1,
          taskId: task.taskId,
          questionId: 'question-one',
          replyId: 'reply-one',
          reply: 'Inspect source.ts.',
        }),
      report: () =>
        records.acceptReport(directory, task.taskId, {
          taskId: task.taskId,
          outcome: 'success',
          summary: 'Done.',
          evidence: [],
        }),
      assignment: () => {
        publishAssignment('submitted');
      },
      assignmentUncertain: () => {
        publishAssignment('uncertain');
      },
      timeoutStopped: () => {
        records.recordEvent(directory, task.taskId, 'timeout', {
          detail: 'Timed out.',
          stopped: true,
        });
      },
      settledStopped: () => {
        records.recordEvent(directory, task.taskId, 'settled', {
          detail: 'Settled.',
          stopped: true,
        });
      },
      cleanupStopped: () => {
        records.recordEvent(directory, task.taskId, 'cleanup', {
          detail: 'Stopped.',
          stopped: true,
        });
      },
    };

    for (const name of saved) {
      const recordWrite = write[name];

      if (recordWrite) {
        recordWrite();
      } else {
        records.recordEvent(directory, task.taskId, name, name);
      }
    }

    expect(workerState(directory, records.readTask(directory), owner, enforcing)).toBe(state);
  },
);

it('reads a saved pane identity and fails closed on invalid pane evidence', () => {
  const { directory } = questionFixture();

  expect(records.readPane(directory)).toBeUndefined();
  records.publish(directory, 'pane.json', { paneId: 'pane-one', terminalId: 'terminal-one' });
  expect(records.readPane(directory)).toBe('pane-one');
  writeFileSync(join(directory, 'pane.json'), JSON.stringify({ paneId: '' }));
  expect(() => records.readPane(directory)).toThrow('Invalid saved worker pane');
});
