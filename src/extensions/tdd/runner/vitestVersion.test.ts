import { expect, it } from 'vitest';

import { supportsFocusedVitest } from './vitestVersion.js';

it.for([
  { version: '1.6.1', supported: false },
  { version: '2.0.5', supported: false },
  { version: '2.1.0-beta.1', supported: false },
  { version: '2.1.0-beta.1+build', supported: false },
  { version: '2.1.0', supported: true },
  { version: '2.1.0+build-name', supported: true },
  { version: '2.1.1-beta.1', supported: true },
  { version: '2.2.0', supported: true },
  { version: '3.0.0', supported: true },
  { version: '4.1.11', supported: true },
  { version: '5.0.0-beta.1', supported: true },
])('selects focused entry support for Vitest $version', ({ version, supported }) => {
  expect(supportsFocusedVitest(version)).toBe(supported);
});
