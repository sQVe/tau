import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createLinearFake } from '../../../tests/linearFake.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
import { comment } from './comment.js';
import { prepare } from './prepare.js';

afterEach(() => vi.unstubAllEnvs());

const setup = async () => {
  const directory = await createTemporaryRepository(onTestFinished);
  const fake = createLinearFake();
  const ticket = fake.addIssue({ title: 'Comment target' });
  const heading = `# Code quality: ${ticket.identifier}`;
  const bodyFile = join(directory, 'body.md');
  const body = `${heading}\n\nChecked.`;
  await writeFile(bodyFile, body);
  const request = { ticket: ticket.identifier, heading, bodyFile };
  const prepared = await prepare(directory, ticket.identifier.toLowerCase());

  return { directory, fake, ticket, heading, body, request, prepared };
};

it('adds a comment and saves its ID under the heading', async () => {
  const directory = await createTemporaryRepository(onTestFinished);
  const fake = createLinearFake();
  const ticket = fake.addIssue({ title: 'Comment target' });
  const heading = `# Code review: ${ticket.identifier}`;
  const bodyFile = join(directory, 'body.md');
  await writeFile(bodyFile, `${heading}\n\nReviewed.`);

  const result = await comment(fake.exec, noUiContext(directory), {
    ticket: ticket.identifier,
    heading,
    bodyFile,
  });

  expect(result).toMatchObject({ status: 'added', previousBody: null });
  expect(result.id).toEqual(expect.any(String));
  expect(result.url).toEqual(expect.any(String));
  expect(fake.writes()).toHaveLength(1);
  const saved: unknown = JSON.parse(await readFile(join(result.directory, 'draft.json'), 'utf8'));

  expect(saved).toEqual({
    version: 3,
    identifier: ticket.identifier,
    comments: { [heading]: result.id },
  });
});

it.each(['saved ID', 'heading'])('updates a comment by %s', async (match) => {
  const state = await setup();
  const previousBody = `${state.heading}\nOld report`;
  const existing = state.fake.addComment({ ticket: state.ticket.identifier, body: previousBody });
  const otherHeading = '# Other report';
  const comments = { [otherHeading]: 'unrelated' };

  if (match === 'saved ID') {
    Object.assign(comments, { [state.heading]: existing.id });
    state.fake.addComment({ ticket: state.ticket.identifier, body: previousBody });
  }

  await writeFile(
    join(state.prepared.directory, 'draft.json'),
    JSON.stringify({ version: 3, identifier: null, comments }),
  );

  const result = await comment(state.fake.exec, noUiContext(state.directory), state.request);

  expect(result).toEqual({
    status: 'updated',
    id: existing.id,
    url: existing.url,
    directory: state.prepared.directory,
    previousBody,
  });

  expect(existing.body).toBe(state.body);
  expect(state.fake.writes()).toHaveLength(1);
  const saved: unknown = JSON.parse(await readFile(join(result.directory, 'draft.json'), 'utf8'));

  expect(saved).toEqual({
    version: 3,
    identifier: state.ticket.identifier,
    comments: { ...comments, [state.heading]: existing.id },
  });
});

it('adds a quality comment without changing a review comment', async () => {
  const state = await setup();
  const reviewBody = `# Code review: ${state.ticket.identifier}\nReview`;
  const review = state.fake.addComment({ ticket: state.ticket.identifier, body: reviewBody });

  const result = await comment(state.fake.exec, noUiContext(state.directory), state.request);

  expect(result.status).toBe('added');
  expect(result.id).not.toBe(review.id);
  expect(review.body).toBe(reviewBody);
  expect(state.fake.comments.get(result.id!)?.body).toBe(state.body);
});

it.each([
  'heading mismatch',
  'ambiguous comments',
  'another page',
  'malformed response',
  'missing ticket',
  'failed read',
  'failed write',
  'malformed draft',
])('refuses %s without changing the draft or comments', async (reason) => {
  const state = await setup();
  const draftPath = join(state.prepared.directory, 'draft.json');
  let draft = JSON.stringify({ version: 3, identifier: state.ticket.identifier, comments: {} });

  if (reason === 'heading mismatch') {
    await writeFile(state.request.bodyFile, 'Not the heading');
  }

  if (reason === 'ambiguous comments') {
    state.fake.addComment({ ticket: state.ticket.identifier, body: state.body, id: 'first' });
    state.fake.addComment({ ticket: state.ticket.identifier, body: state.body, id: 'second' });
  }

  if (reason === 'another page') {
    state.fake.addComment({ ticket: state.ticket.identifier, body: state.body });
    state.fake.limitComments(0);
  }

  if (reason === 'malformed response') {
    state.fake.overrideOutput('comments(', '{"data":{}}');
  }

  if (reason === 'missing ticket') {
    state.fake.issues.clear();
  }

  if (reason === 'failed read') {
    state.fake.failCall('comments(', 'network error');
  }

  if (reason === 'failed write') {
    state.fake.failWrite(1);
  }

  if (reason === 'malformed draft') {
    draft = '{';
  }

  await writeFile(draftPath, draft);
  const before = structuredClone([...state.fake.comments]);

  await expect(
    comment(state.fake.exec, noUiContext(state.directory), state.request),
  ).rejects.toThrow(
    /first line|Several comments|another page|unexpected output|no issue|network error|not JSON/,
  );

  expect(await readFile(draftPath, 'utf8')).toBe(draft);
  expect([...state.fake.comments]).toEqual(before);
  expect(state.fake.writes()).toHaveLength(reason === 'failed write' ? 1 : 0);
});

it.each(['add', 'update'])(
  'refuses an unsuccessful comment receipt for %s without saving an ID',
  async (action) => {
    const state = await setup();

    if (action === 'update') {
      state.fake.addComment({ ticket: state.ticket.identifier, body: state.body });
    }

    const mutation = action === 'add' ? 'commentCreate' : 'commentUpdate';

    state.fake.overrideOutput(
      mutation,
      JSON.stringify({
        data: { [mutation]: { success: false, comment: { id: 'unconfirmed', url: 'url' } } },
      }),
    );

    const before = structuredClone([...state.fake.comments]);

    await expect(
      comment(state.fake.exec, noUiContext(state.directory), state.request),
    ).rejects.toThrow('unexpected output');

    expect([...state.fake.comments]).toEqual(before);

    await expect(readFile(join(state.prepared.directory, 'draft.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it('refuses a symlinked draft before writing a comment', async () => {
  const state = await setup();
  const target = join(state.directory, 'saved.json');
  const text = JSON.stringify({ version: 3, identifier: state.ticket.identifier, comments: {} });
  await writeFile(target, text);
  await symlink(target, join(state.prepared.directory, 'draft.json'));

  await expect(
    comment(state.fake.exec, noUiContext(state.directory), state.request),
  ).rejects.toThrow('symlink');

  expect(state.fake.writes()).toEqual([]);
  expect(state.fake.comments.size).toBe(0);
  expect(await readFile(target, 'utf8')).toBe(text);
});

it('declines a new foreign comment without an ID or a saved draft', async () => {
  const state = await setup();
  state.ticket.assigneeId = 'someone-else';

  const result = await comment(state.fake.exec, noUiContext(state.directory), state.request);

  expect(result).toEqual({
    status: 'declined',
    id: null,
    url: null,
    previousBody: null,
    directory: state.prepared.directory,
  });

  expect(state.fake.writes()).toEqual([]);
  expect(state.fake.comments.size).toBe(0);

  await expect(readFile(join(state.prepared.directory, 'draft.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('refuses to overwrite a comment edited during confirmation', async () => {
  const state = await setup();
  state.ticket.assigneeId = 'someone-else';

  const existing = state.fake.addComment({
    ticket: state.ticket.identifier,
    body: `${state.heading}\nOld report`,
  });

  const draftPath = join(state.prepared.directory, 'draft.json');

  const draft = JSON.stringify({
    version: 3,
    identifier: state.ticket.identifier,
    comments: { [state.heading]: existing.id },
  });

  await writeFile(draftPath, draft);
  const editedBody = `${state.heading}\nNew findings from another session`;

  const context = confirmContext(state.directory, async () => {
    existing.body = editedBody;

    return true;
  });

  await expect(comment(state.fake.exec, context, state.request)).rejects.toThrow(
    /changed.*confirm|changed.*answer/,
  );

  expect(state.fake.writes()).toEqual([]);
  expect(existing.body).toBe(editedBody);
  expect(await readFile(draftPath, 'utf8')).toBe(draft);
});

it('refuses to add a duplicate when a matching comment appears during confirmation', async () => {
  const state = await setup();
  state.ticket.assigneeId = 'someone-else';
  const appearedBody = `${state.heading}\nReport from another session`;

  const context = confirmContext(state.directory, async () => {
    state.fake.addComment({ ticket: state.ticket.identifier, body: appearedBody });

    return true;
  });

  await expect(comment(state.fake.exec, context, state.request)).rejects.toThrow(
    /changed.*confirm|changed.*answer/,
  );

  expect(state.fake.writes()).toEqual([]);
  expect([...state.fake.comments.values()].map((saved) => saved.body)).toEqual([appearedBody]);

  await expect(readFile(join(state.prepared.directory, 'draft.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each(['ownership changed', 'ticket missing', 'response malformed', 'read failed'])(
  'refuses a comment after confirmation when %s',
  async (change) => {
    const state = await setup();
    state.ticket.assigneeId = 'someone-else';

    const existing = state.fake.addComment({
      ticket: state.ticket.identifier,
      body: `${state.heading}\nOld report`,
    });

    const originalBody = existing.body;

    const context = confirmContext(state.directory, async () => {
      if (change === 'ownership changed') {
        state.ticket.assigneeId = 'another-person';
      }

      if (change === 'ticket missing') {
        state.fake.issues.clear();
      }

      if (change === 'response malformed') {
        state.fake.overrideOutput('comments(', '{"data":{}}');
      }

      if (change === 'read failed') {
        state.fake.failCall('comments(', 'network error');
      }

      return true;
    });

    await expect(comment(state.fake.exec, context, state.request)).rejects.toThrow(
      /changed while you answered|no issue|unexpected output|network error/,
    );

    expect(state.fake.writes()).toEqual([]);
    expect(existing.body).toBe(originalBody);

    await expect(readFile(join(state.prepared.directory, 'draft.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it('updates a foreign ticket after showing the old and new comment', async () => {
  const state = await setup();
  state.ticket.assigneeId = 'someone-else';
  const previousBody = `${state.heading}\nOld report`;
  const old = state.fake.addComment({ ticket: state.ticket.identifier, body: previousBody });
  const prompts: string[] = [];

  const context = confirmContext(state.directory, async (_title, message) => {
    prompts.push(message);

    return true;
  });

  const result = await comment(state.fake.exec, context, state.request);

  expect(result.status).toBe('updated');
  expect(old.body).toBe(state.body);
  expect(state.fake.writes()).toHaveLength(1);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(previousBody);
  expect(prompts[0]).toContain(state.body);
});

it.each(['declined', 'no UI', 'worker'])('handles foreign ticket approval: %s', async (mode) => {
  const state = await setup();
  state.ticket.assigneeId = 'someone-else';

  const old = state.fake.addComment({
    ticket: state.ticket.identifier,
    body: `${state.heading}\nOld`,
  });

  const previousBody = old.body;
  const prompts: string[] = [];

  const context =
    mode === 'no UI'
      ? noUiContext(state.directory)
      : confirmContext(state.directory, async (_title, message) => {
          prompts.push(message);

          return false;
        });

  if (mode === 'worker') {
    vi.stubEnv('TAU_ROLE', 'worker');
  }

  const result = await comment(state.fake.exec, context, state.request);

  expect(result).toMatchObject({
    status: 'declined',
    id: old.id,
    url: old.url,
    previousBody,
  });

  expect(state.fake.writes()).toHaveLength(0);
  expect(prompts).toHaveLength(mode === 'declined' ? 1 : 0);

  await expect(readFile(join(state.prepared.directory, 'draft.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });

  expect(old.body).toBe(previousBody);
});
