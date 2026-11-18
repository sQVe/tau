import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { parseSyncRecord } from './syncRecord.js';

interface Row {
  name: string;
  text: string;
  expected: unknown;
}

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/syncRecord/${name}.toml`, import.meta.url), 'utf8');

const hash = 'a'.repeat(64);

const current = (files: string, head = 'schema = 1\nversion = "0.2.0"') =>
  `${head}\n\n[files]\n${files}\n`;

const previous = (files: string) => `version = "0.0.0"\n\n[files]\n${files}\n`;

const refused = (message: string): unknown => ({
  error: expect.stringContaining(message) as unknown,
});

const rows: Row[] = [
  {
    name: 'the current shape',
    text: fixture('current'),
    expected: {
      version: '0.1.0',
      files: {
        'shared/coding.md': '521e918b76d54a202d9a527fb9cafeee30c332342497fa22920fd6b06443b5f1',
      },
    },
  },
  {
    name: 'the current shape without agents',
    text: current(`"shared/coding.md" = "${hash}"`),
    expected: { version: '0.2.0', files: { 'shared/coding.md': hash } },
  },
  {
    name: 'the previous shape',
    text: fixture('previous'),
    expected: {
      version: '0.0.0',
      files: {
        'shared/coding.md': '919baa8f37690aee6bf6b6b9aea7976dc97c216e7048172f11db9f46d0c99cf2',
      },
    },
  },
  { name: 'invalid TOML', text: 'schema = = 1', expected: refused('is not valid TOML') },
  {
    name: 'a newer schema',
    text: fixture('newer'),
    expected: refused('uses record schema 2; update Tau'),
  },
  {
    name: 'a float schema',
    text: current('', 'schema = 1.0\nversion = "0.2.0"'),
    expected: refused('has an unreadable `schema`'),
  },
  {
    name: 'a schema of zero',
    text: current('', 'schema = 0\nversion = "0.2.0"'),
    expected: refused('has an unreadable `schema`'),
  },
  {
    name: 'a text schema',
    text: current('', 'schema = "1"\nversion = "0.2.0"'),
    expected: refused('has an unreadable `schema`'),
  },
  {
    name: 'an unknown key',
    text: current('', 'schema = 1\nversion = "0.2.0"\nextra = true'),
    expected: refused('has the unknown key `extra`'),
  },
  {
    name: 'agents in the previous shape',
    text: `agents = "${hash}"\n${previous('')}`,
    expected: refused('has the unknown key `agents`'),
  },
  {
    name: 'a missing version',
    text: current('', 'schema = 1'),
    expected: refused('has no `version`'),
  },
  {
    name: 'an empty version',
    text: current('', 'schema = 1\nversion = ""'),
    expected: refused('has no `version`'),
  },
  {
    name: 'a version that is not text',
    text: current('', 'schema = 1\nversion = 2'),
    expected: refused('has no `version`'),
  },
  {
    name: 'files that are not a table',
    text: fixture('malformed'),
    expected: refused('has no `[files]`'),
  },
  {
    name: 'missing files',
    text: 'schema = 1\nversion = "0.2.0"\n',
    expected: refused('has no `[files]`'),
  },
  {
    name: 'files as a list',
    text: 'schema = 1\nversion = "0.2.0"\nfiles = []\n',
    expected: refused('has no `[files]`'),
  },
  {
    name: 'files as a date',
    text: 'schema = 1\nversion = "0.2.0"\nfiles = 2026-01-01\n',
    expected: refused('has no `[files]`'),
  },
  {
    name: 'a short hash',
    text: current(`"shared/coding.md" = "${hash.slice(1)}"`),
    expected: refused('has a hash for shared/coding.md that is not'),
  },
  {
    name: 'a long hash',
    text: current(`"shared/coding.md" = "${hash}a"`),
    expected: refused('has a hash for shared/coding.md that is not'),
  },
  {
    name: 'an uppercase hash',
    text: current(`"shared/coding.md" = "${hash.toUpperCase()}"`),
    expected: refused('has a hash for shared/coding.md that is not'),
  },
  {
    name: 'a hash that is not text',
    text: current('"shared/coding.md" = 1'),
    expected: refused('has a hash for shared/coding.md that is not'),
  },
  {
    name: 'an absolute path',
    text: current(`"/etc/passwd" = "${hash}"`),
    expected: refused('has the absolute path /etc/passwd'),
  },
  {
    name: 'a path through a parent folder',
    text: current(`"shared/../../coding.md" = "${hash}"`),
    expected: refused('has the path shared/../../coding.md, which holds `..`'),
  },
  {
    name: 'a path with a backslash',
    text: current(`'shared\\coding.md' = "${hash}"`),
    expected: refused('has the path shared\\coding.md, which holds a backslash'),
  },
  {
    name: 'a previous path outside docs/stomme/',
    text: previous(`"docs/adr/README.md" = "${hash}"`),
    expected: refused('has the path docs/adr/README.md, which is outside docs/stomme/'),
  },
  {
    name: 'a previous path through a parent folder',
    text: previous(`"docs/stomme/../coding.md" = "${hash}"`),
    expected: refused('which holds `..`'),
  },
];

const outcome = (text: string) => {
  try {
    const record = parseSyncRecord(text);

    return { version: record.version, files: Object.fromEntries(record.files) };
  } catch (error) {
    return { error: String(error) };
  }
};

it('reads each sync record shape', () => {
  for (const { name, text, expected } of rows) {
    expect(outcome(text), name).toEqual(expected);
  }
});
