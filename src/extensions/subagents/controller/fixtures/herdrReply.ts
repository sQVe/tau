import { readFileSync } from 'node:fs';

export const herdrReply = (name: string): string =>
  readFileSync(new URL(`./herdr/${name}`, import.meta.url), 'utf8');
