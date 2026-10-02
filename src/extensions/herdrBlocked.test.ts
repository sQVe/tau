import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { fakeExtensionApi } from '../../tests/extensionApi.js';
import herdrBlockedExtension from './herdrBlocked.js';

const forwardedEvents = (events: { type: string; kind: string; title?: string }[]) => {
  const api = fakeExtensionApi();
  herdrBlockedExtension(api.pi);
  const received: unknown[] = [];
  api.pi.events.on('herdr:blocked', (data) => received.push(data));

  for (const event of events) {
    api.handler(event.type)({ reason: 'ui_prompt', ...event }, {} as ExtensionContext);
  }

  return received;
};

describe('Herdr blocked state', () => {
  it('reports a blocking prompt with its title', () => {
    expect(
      forwardedEvents([{ type: 'ui_prompt_start', kind: 'custom', title: 'Pick a library' }]),
    ).toStrictEqual([{ active: true, label: 'Pick a library' }]);
  });

  it('labels an untitled prompt with its kind', () => {
    expect(forwardedEvents([{ type: 'ui_prompt_start', kind: 'confirm' }])).toStrictEqual([
      { active: true, label: 'confirm' },
    ]);
  });

  it('reports the end of a prompt', () => {
    expect(
      forwardedEvents([{ type: 'ui_prompt_end', kind: 'input', title: 'Name' }]),
    ).toStrictEqual([{ active: false }]);
  });
});
