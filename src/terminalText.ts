import { stripVTControlCharacters } from 'node:util';

export const sanitizeSingleLine = (text: string): string =>
  stripVTControlCharacters(text).replace(/\p{Cc}/gu, ' ');
