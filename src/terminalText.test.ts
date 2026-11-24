import { expect, it } from 'vitest';

import { sanitizeSingleLine } from './terminalText.js';

it('removes escape sequences and turns control characters into spaces', () => {
  expect(sanitizeSingleLine('a\u001B[31mb\nc\td')).toBe('ab c d');
});
