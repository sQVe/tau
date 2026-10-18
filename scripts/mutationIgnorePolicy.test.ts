import { describe, expect, it } from 'vitest';

import { ignorerName, enabledIgnorers } from './mutationIgnorePolicy.ts';

describe('enabledIgnorers', () => {
  it.each([
    { name: 'the list names the ignorer', ignorers: [ignorerName], enabled: true },
    { name: 'the list names it among others', ignorers: ['other', ignorerName], enabled: true },
    { name: 'the list is missing', ignorers: undefined, enabled: false },
    { name: 'the list is empty', ignorers: [], enabled: false },
    { name: 'the list names only other ignorers', ignorers: ['other'], enabled: false },
  ])('returns the ignorer only when enabled: $enabled, $name', ({ ignorers, enabled }) => {
    const ignorer = { shouldIgnore: () => undefined };

    expect(enabledIgnorers(ignorers, ignorer)).toEqual(enabled ? [ignorer] : []);
  });
});
