import { describe, expect, it } from 'vitest';

import { isWriteWithinRoot } from './writeDecision.ts';

describe('isWriteWithinRoot', () => {
  it.each([
    { name: 'no root', target: '/tmp/outside/event.json', root: undefined, allowed: true },
    { name: 'an empty root', target: '/tmp/outside/event.json', root: '', allowed: true },
    { name: 'the root', target: '/tmp/tau-root', root: '/tmp/tau-root', allowed: true },
    {
      name: 'a path inside the root',
      target: '/tmp/tau-root/event.json',
      root: '/tmp/tau-root',
      allowed: true,
    },
    {
      name: 'a sibling with the root as a prefix',
      target: '/tmp/tau-root-other/event.json',
      root: '/tmp/tau-root',
      allowed: false,
    },
    {
      name: 'another temporary directory',
      target: '/tmp/tau-other/event.json',
      root: '/tmp/tau-root',
      allowed: false,
    },
    {
      name: 'a relative target',
      target: 'event.json',
      root: '/tmp/tau-root',
      allowed: false,
    },
    {
      name: 'a relative root',
      target: '/tmp/tau-root/event.json',
      root: 'tau-root',
      allowed: false,
    },
  ])('$name', ({ target, root, allowed }) => {
    expect(isWriteWithinRoot(target, root)).toBe(allowed);
  });
});
