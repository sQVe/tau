import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  commitFailedError,
  commitToolParameters,
  normalizeRepositoryPath,
  validatePaths,
  validateSubject,
} from './validation.js';

const accepted = [
  { name: 'a subject group', input: { groups: [{ files: ['a.txt'], subject: 'feat: a' }] } },
  { name: 'a body', input: { groups: [{ files: ['a.txt'], subject: 'feat: a', body: 'text' }] } },
  ...(['fixup', 'squash', 'amend'] as const).map((kind) => ({
    name: `a ${kind} fixup`,
    input: { groups: [{ files: ['a.txt'], fixup: { target: 'HEAD', kind } }] },
  })),
];

const rejected = [
  { name: 'no groups', input: { groups: [] } },
  { name: 'a missing groups list', input: {} },
  { name: 'a group without files', input: { groups: [{ files: [], subject: 'feat: a' }] } },
  { name: 'a non-string file', input: { groups: [{ files: [1], subject: 'feat: a' }] } },
  {
    name: 'an unknown fixup kind',
    input: { groups: [{ files: ['a.txt'], fixup: { target: 'HEAD', kind: 'reword' } }] },
  },
  {
    name: 'a fixup without a target',
    input: { groups: [{ files: ['a.txt'], fixup: { kind: 'fixup' } }] },
  },
];

it.each(accepted)('accepts $name', ({ input }) => {
  expect(Value.Check(commitToolParameters, input)).toBe(true);
});

it.each(rejected)('rejects $name', ({ input }) => {
  expect(Value.Check(commitToolParameters, input)).toBe(false);
});

it.each([
  { file: 'dir\\file.txt', expected: 'dir\\file.txt' },
  { file: 'dir//sub/', expected: 'dir/sub' },
])('normalizes $file', ({ file, expected }) => {
  expect(normalizeRepositoryPath(file)).toBe(expected);
});

describe('validateSubject', () => {
  it('throws a validation error naming the subject when it is not a conventional commit', () => {
    const subject = 'Add stuff.';

    expect(() => {
      validateSubject(subject);
    }).toThrow(new RegExp(`subject.*${subject.replace('.', '\\.')}`, 'i'));
  });

  it('names the allowed types when it rejects a subject', () => {
    for (const type of ['fix', 'refactor', 'revert']) {
      expect(() => {
        validateSubject('feat(prFeedback): x');
      }).toThrow(new RegExp(`\\b${type}\\b`));
    }
  });

  it('returns without throwing when the subject is a conventional commit', () => {
    expect(() => {
      validateSubject('feat: add thing');
    }).not.toThrow();

    expect(() => {
      validateSubject('fix(scope): do it');
    }).not.toThrow();

    expect(() => {
      validateSubject('chore!: breaking');
    }).not.toThrow();
  });
});

describe('validatePaths', () => {
  it('throws an error naming the offending path when any file matches the sensitive denylist', () => {
    expect(() => {
      validatePaths(['.env']);
    }).toThrow(/\.env/);

    expect(() => {
      validatePaths(['db/credentials.json']);
    }).toThrow(/db\/credentials\.json/);

    expect(() => {
      validatePaths(['keys/id_rsa']);
    }).toThrow(/keys\/id_rsa/);

    expect(() => {
      validatePaths(['.ssh/config']);
    }).toThrow(/\.ssh\/config/);
  });

  it('names the sensitive pattern that matched the path', () => {
    expect(() => {
      validatePaths(['docs/secrets_management.md']);
    }).toThrow('/secret/i');
  });

  it('rejects paths with leading dot-slash that would bypass anchored patterns', () => {
    expect(() => {
      validatePaths(['./.env']);
    }).toThrow(/\.env/);
  });

  it('rejects sensitive paths that redundant separators would otherwise hide', () => {
    expect(() => {
      validatePaths(['.//id_rsa']);
    }).toThrow(/id_rsa/);

    expect(() => {
      validatePaths(['./././id_rsa']);
    }).toThrow(/id_rsa/);
  });

  it('rejects sensitive files in subdirectories', () => {
    expect(() => {
      validatePaths(['config/.env']);
    }).toThrow(/config\/\.env/);

    expect(() => {
      validatePaths(['packages/app/.npmrc']);
    }).toThrow(/\.npmrc/);

    expect(() => {
      validatePaths(['home/.ssh/config']);
    }).toThrow(/\.ssh/);
  });

  it('rejects sensitive paths whose casing differs from the pattern', () => {
    expect(() => {
      validatePaths(['.ENV']);
    }).toThrow(/\.ENV/);

    expect(() => {
      validatePaths(['.Env.production']);
    }).toThrow(/\.Env\.production/);
  });

  it('rejects paths that resolve to the repository root', () => {
    for (const pathspec of ['./', '.', './.', 'src/..']) {
      expect(() => {
        validatePaths([pathspec]);
      }).toThrow(/Invalid path/);
    }
  });

  it('rejects an .ssh directory named without a trailing slash', () => {
    expect(() => {
      validatePaths(['.ssh']);
    }).toThrow(/\.ssh/);

    expect(() => {
      validatePaths(['home/.ssh']);
    }).toThrow(/\.ssh/);
  });

  it('accepts filenames containing glob characters, which git takes literally', () => {
    expect(() => {
      validatePaths(['app/[slug]/page.tsx', 'docs/faq?.md']);
    }).not.toThrow();
  });

  it('rejects pathspec magic and traversal attempts', () => {
    expect(() => {
      validatePaths([':(glob)*.ts']);
    }).toThrow(/Invalid path/);

    expect(() => {
      validatePaths(['../etc/passwd']);
    }).toThrow(/Invalid path/);

    expect(() => {
      validatePaths(['/etc/passwd']);
    }).toThrow(/Invalid path/);
  });

  it('keeps backslash traversal and sensitive path validation', () => {
    for (const path of [
      '..\\private',
      'src\\..\\..\\private',
      '.ssh\\config',
      'config\\.env',
      'folder\\credentials.json',
    ]) {
      expect(() => {
        validatePaths([path]);
      }).toThrow(/Invalid path/);
    }
  });

  it('rejects traversal that only escapes the repository once collapsed', () => {
    expect(() => {
      validatePaths(['src/../../etc/passwd']);
    }).toThrow(/Invalid path/);

    expect(() => {
      validatePaths(['src/..']);
    }).toThrow(/Invalid path/);
  });

  it('returns without throwing when all files are outside the sensitive denylist', () => {
    expect(() => {
      validatePaths(['src/foo.ts', 'README.md', 'docs/env.md']);
    }).not.toThrow();
  });
});

it('preserves raw hook output including whitespace in both streams', () => {
  expect(commitFailedError('hook output  \n', '   \n').message).toBe(
    'git commit failed:\nhook output  \n   \n',
  );
});

it('keeps both streams in the error message when a hook writes to each', () => {
  const message = commitFailedError('lint failed on src/a.ts\n', 'warning: slow hook\n').message;

  expect(message).toContain('lint failed on src/a.ts');
  expect(message).toContain('warning: slow hook');
});

it('drops ANSI escapes and lint-staged progress lines but keeps the real error', () => {
  const stdout = [
    '\u001B[33m[STARTED]\u001B[39m Preparing lint-staged...',
    '[COMPLETED] Preparing lint-staged...',
    '[SKIPPED] *.md — no files',
    '\u001B[31m[FAILED]\u001B[39m eslint --fix [FAILED]',
    '',
  ].join('\n');

  const stderr = '\u001B[1msrc/a.ts:3:1 error no-unused-vars\u001B[22m\n';

  expect(commitFailedError(stdout, stderr).message).toBe(
    'git commit failed:\n[FAILED] eslint --fix [FAILED]\nsrc/a.ts:3:1 error no-unused-vars\n',
  );
});
