import { expect, it } from 'vitest';

import { readQuoted } from './gitQuotedName.js';

it('reads a name and the text after its closing quote', () => {
  expect(readQuoted('"src/a.ts" b/src/a.ts')).toEqual({ name: 'src/a.ts', rest: ' b/src/a.ts' });
});

it('reads octal escapes as UTF-8 bytes', () => {
  expect(readQuoted('"caf\\303\\251"').name).toBe('café');
});

it('reads a letter escape that is followed by digits as the letter escape', () => {
  expect(readQuoted('"a\\t123"').name).toBe('a\t123');
});

it('reads escaped quotes and backslashes', () => {
  expect(readQuoted('"a\\"b\\\\c"').name).toBe('a"b\\c');
});

it('ends an unterminated name at the end of the text', () => {
  expect(readQuoted('"abc')).toEqual({ name: 'abc', rest: '' });
});
