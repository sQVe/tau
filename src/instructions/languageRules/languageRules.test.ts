import { expect, it } from 'vitest';

import { writeStommeProject } from '../../../tests/stommeProjectHarness.js';
import {
  bundledRules,
  delivered,
  languageCases,
  setupLanguageRules,
} from './fixtures/languageRulesHarness.js';

for (const { language, label, customType, path } of languageCases) {
  const rules = bundledRules(language);
  const ruleMessage = { role: 'custom', customType, content: rules };

  it(`delivers ${label} rules after the first read without blocking it`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.request();

    expect(await fixture.call('read', path)).not.toContainEqual(
      expect.objectContaining({ block: true }),
    );

    expect(fixture.api.sendMessage).toHaveBeenCalledExactlyOnceWith(delivered(customType, rules), {
      deliverAs: 'steer',
    });

    expect(fixture.appendEntry).toHaveBeenCalledExactlyOnceWith(customType, {
      version: 1,
    });

    await fixture.call('read', path);
    expect(fixture.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it(`allows the first ${label} edit in the request after a read delivered the rules`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.request();
    await fixture.call('read', path);
    await fixture.request([ruleMessage]);

    expect(await fixture.call('edit', path)).toEqual([undefined]);
    expect(fixture.api.sendMessage).toHaveBeenCalledOnce();
  });

  it(`blocks a ${label} write until a model request sees the rules`, async ({ onTestFinished }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.request();
    const first = await fixture.call('write', path);
    const sibling = await fixture.call('edit', path, 'codemode-call');
    const reason: unknown = expect.stringMatching(/loaded.*reconsider/isu);

    expect(first).toEqual([expect.objectContaining({ block: true, reason })]);
    expect(sibling).toEqual(first);
    expect(fixture.appendEntry).toHaveBeenCalledTimes(1);
    expect(fixture.api.sendMessage).toHaveBeenCalledTimes(1);

    await fixture.request([ruleMessage]);
    expect(await fixture.call('write', path)).toEqual([undefined]);
  });

  it(`appends ${label} rules to the next run after resume from a saved entry`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    fixture.sessionManager.appendCustomEntry(customType, { version: 1 });
    await fixture.emit('session_start', { reason: 'resume' });

    expect(await fixture.prompt()).toBe(rules);
    await fixture.request();
    expect(await fixture.call('write', path)).toEqual([undefined]);
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`sends ${label} rules again after compaction during the activation run`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.prompt();
    await fixture.call('read', path);
    fixture.api.sendMessage.mockClear();
    await fixture.emit('session_compact');

    expect(fixture.api.sendMessage).toHaveBeenCalledExactlyOnceWith(delivered(customType, rules), {
      deliverAs: 'steer',
    });
  });

  it(`does not resend ${label} rules after compaction when a run already carries them`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.call('read', path);
    await fixture.prompt();
    fixture.api.sendMessage.mockClear();
    await fixture.emit('session_compact');
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`does not send a ${label} compaction message while idle or inactive`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.emit('session_compact');
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
    await fixture.call('read', path);
    fixture.idle.mockReturnValue(true);
    fixture.api.sendMessage.mockClear();
    await fixture.emit('session_compact');
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
    expect(await fixture.prompt()).toBe(rules);
  });

  it(`rebuilds ${label} activation when moving to another branch`, async ({ onTestFinished }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.call('read', path);
    expect(await fixture.prompt()).toBe(rules);
    fixture.sessionManager.resetLeaf();
    await fixture.emit('session_tree');
    expect(await fixture.prompt()).toBe('');
  });

  it.for([
    { kind: 'newer', data: { version: 2 }, detail: '2' },
    { kind: 'malformed', data: { version: '1' }, detail: label },
  ])(
    `reports $kind ${label} activation evidence without activating`,
    async ({ data, detail }, { onTestFinished }) => {
      const fixture = await setupLanguageRules(onTestFinished);

      fixture.sessionManager.appendCustomEntry(customType, data);
      const branch = fixture.sessionManager.getBranch();

      await fixture.emit('session_start', { reason: 'resume' });

      expect(fixture.notify).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(label),
        'warning',
      );

      expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining(detail), 'warning');

      expect(await fixture.prompt()).toBe('');
      expect(fixture.sessionManager.getBranch()).toEqual(branch);
      expect(fixture.appendEntry).not.toHaveBeenCalled();
      expect(fixture.api.sendMessage).not.toHaveBeenCalled();
    },
  );

  it.for(['session_start', 'session_tree'])(
    `reports unreadable ${label} activation evidence on %s without losing valid activation`,
    async (event, { onTestFinished }) => {
      const fixture = await setupLanguageRules(onTestFinished);

      fixture.sessionManager.appendCustomEntry(customType, { version: 2 });
      fixture.sessionManager.appendCustomEntry(customType, { version: '1' });
      fixture.sessionManager.appendCustomEntry(customType, { version: 1 });
      const branch = fixture.sessionManager.getBranch();

      await fixture.emit(event);

      const warnings = fixture.notify.mock.calls.filter(([, level]) => level === 'warning');

      const messages = warnings.map(([message]) => message);
      const newer = messages.filter((message) => message.includes('2'));
      const malformed = messages.filter((message) => !message.includes('2'));

      expect(warnings).toHaveLength(2);
      expect(newer).toHaveLength(1);
      expect(malformed).toHaveLength(1);
      expect(malformed[0]).toContain(label);
      expect(await fixture.prompt()).toBe(rules);
      expect(fixture.sessionManager.getBranch()).toEqual(branch);
      expect(fixture.appendEntry).not.toHaveBeenCalled();
      expect(fixture.api.sendMessage).not.toHaveBeenCalled();
    },
  );

  it(`resets ${label} request state when a session starts`, async ({ onTestFinished }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.request([ruleMessage]);
    await fixture.emit('session_start', { reason: 'new' });

    expect(await fixture.call('edit', path)).toEqual([expect.objectContaining({ block: true })]);
  });

  it.for(['session_start', 'session_tree'])(
    `drops the previous ${label} system prompt state on %s`,
    async (event, { onTestFinished }) => {
      const fixture = await setupLanguageRules(onTestFinished);

      await fixture.call('read', path);
      await fixture.prompt();
      await fixture.request();
      fixture.sessionManager.resetLeaf();
      await fixture.emit(event);
      await fixture.request();

      expect(await fixture.call('edit', path)).toEqual([expect.objectContaining({ block: true })]);
    },
  );

  it(`removes the saved ${label} rules message from a resumed request and keeps history`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    fixture.sessionManager.appendCustomEntry(customType, { version: 1 });
    await fixture.emit('session_start', { reason: 'resume' });
    const branch = fixture.sessionManager.getBranch();
    const messages = [ruleMessage, { role: 'user', content: 'Continue.' }];

    expect(await fixture.prompt()).toBe(rules);

    const sent = await fixture.request(messages);

    expect(sent['messages']).toEqual([messages[1]]);
    expect(messages).toHaveLength(2);
    expect(fixture.sessionManager.getBranch()).toEqual(branch);
  });

  it(`keeps the ${label} rules message of the activation run in the request`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    expect(await fixture.prompt()).toBe('');
    await fixture.call('read', path);

    const sent = await fixture.request([ruleMessage]);

    expect(sent['messages']).toEqual([ruleMessage]);
  });

  it(`leaves ${label} first-access rules off in a stomme project`, async ({ onTestFinished }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await writeStommeProject(fixture.directory, { language });
    fixture.sessionManager.appendCustomEntry(customType, { version: 1 });
    await fixture.emit('session_start', { reason: 'resume' });
    fixture.api.sendMessage.mockClear();
    fixture.appendEntry.mockClear();

    expect(await fixture.prompt()).toBe('');
    await fixture.request();
    expect(await fixture.call('read', path)).toEqual([undefined]);
    expect(await fixture.call('write', path)).toEqual([undefined]);
    await fixture.emit('session_compact');
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  });

  it(`drops ${label} bundle rules when stomme.toml appears mid-session`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    expect(await fixture.prompt()).toBe('');
    await fixture.call('read', path);
    const earlier = await fixture.request([ruleMessage]);

    expect(earlier['messages']).toEqual([ruleMessage]);

    await writeStommeProject(fixture.directory, { language });

    expect(await fixture.prompt()).toBe('');

    const kept = { role: 'user', content: 'Continue.' };
    const later = await fixture.request([ruleMessage, kept]);

    expect(later['messages']).toEqual([kept]);
  });

  it(`blocks a ${label} write again when a new run starts before a request sees the rules`, async ({
    onTestFinished,
  }) => {
    const fixture = await setupLanguageRules(onTestFinished);

    await fixture.call('read', path);
    await fixture.prompt();
    await fixture.request([ruleMessage]);
    await fixture.prompt();

    expect(await fixture.call('write', path)).toEqual([expect.objectContaining({ block: true })]);
  });
}

it('leaves a request without rules messages unchanged', async ({ onTestFinished }) => {
  const fixture = await setupLanguageRules(onTestFinished);

  const { results } = await fixture.emit('context', {
    messages: [{ role: 'user', content: 'Continue.' }],
  });

  expect(results).toEqual([undefined]);
});

it('does not treat an unrelated custom message as loaded rules', async ({ onTestFinished }) => {
  const fixture = await setupLanguageRules(onTestFinished);

  await fixture.request([{ role: 'custom', customType: 'other', content: 'text' }]);

  expect(await fixture.call('edit', 'main.ts')).toEqual([expect.objectContaining({ block: true })]);
});

it('keeps the other language off after one activates', async ({ onTestFinished }) => {
  const fixture = await setupLanguageRules(onTestFinished);

  await fixture.call('read', 'main.ts');

  await fixture.request([{ role: 'custom', customType: 'tau-typescript-rules', content: 'rules' }]);

  expect(await fixture.call('write', 'src/lib.rs')).toEqual([
    expect.objectContaining({ block: true }),
  ]);

  expect(fixture.appendEntry).toHaveBeenCalledWith('tau-rust-rules', {
    version: 1,
  });
});

it('leaves sessions without TypeScript or Rust files without rules or messages', async ({
  onTestFinished,
}) => {
  const fixture = await setupLanguageRules(onTestFinished);

  await fixture.call('read', 'README.md');
  await fixture.call('write', 'main.go');

  expect(await fixture.prompt()).toBe('');
  expect(fixture.api.sendMessage).not.toHaveBeenCalled();
  expect(fixture.appendEntry).not.toHaveBeenCalled();
});
