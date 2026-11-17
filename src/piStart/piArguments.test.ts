import { expect, it } from 'vitest';

import { piArguments } from './piArguments.js';

it('an environment puts env first', () => {
  const argv = piArguments({
    model: undefined,
    session: undefined,
    environment: { TAU_ROLE: 'architect' },
    message: undefined,
  });

  expect(argv).toEqual(['env', 'TAU_ROLE=architect', 'pi']);
});

it('an empty environment adds no env', () => {
  const argv = piArguments({
    model: undefined,
    session: undefined,
    environment: {},
    message: undefined,
  });

  expect(argv).toEqual(['pi']);
});

it('a model pins its provider', () => {
  const argv = piArguments({
    model: 'claude-bridge/claude-opus-5-5',
    session: undefined,
    environment: undefined,
    message: undefined,
  });

  expect(argv).toEqual(['pi', '--provider', 'claude-bridge', '--model', 'claude-opus-5-5']);
});

it('a session resumes a file', () => {
  const argv = piArguments({
    model: undefined,
    session: '/tmp/architect.jsonl',
    environment: undefined,
    message: undefined,
  });

  expect(argv).toEqual(['pi', '--session', '/tmp/architect.jsonl']);
});

it('a message is the last argument', () => {
  const argv = piArguments({
    model: 'p/m',
    session: '/tmp/architect.jsonl',
    environment: undefined,
    message: 'question',
  });

  expect(argv).toEqual([
    'pi',
    '--session',
    '/tmp/architect.jsonl',
    '--provider',
    'p',
    '--model',
    'm',
    'question',
  ]);
});
