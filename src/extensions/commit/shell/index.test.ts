import { describe, expect, it, vi } from 'vitest';
import { Language, Parser } from 'web-tree-sitter';

import { findGitCommits, parseBash } from './index.js';

const parseAndFindGitCommits = async (command: string) => findGitCommits(await parseBash(command));

describe('parseBash', () => {
  it('lazily initializes and reuses a shared parser singleton', async () => {
    const initSpy = vi.spyOn(Parser, 'init');
    const loadSpy = vi.spyOn(Language, 'load');

    try {
      await Promise.all([parseBash('echo hello'), parseBash('printf ok')]);

      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(loadSpy).toHaveBeenCalledTimes(1);
    } finally {
      initSpy.mockRestore();
      loadSpy.mockRestore();
    }
  });

  it('returns a tree-sitter AST for a simple command string', async () => {
    const ast = await parseBash('echo hello');

    expect(ast.rootNode.type).toBe('program');
    expect(ast.rootNode.childCount).toBeGreaterThan(0);
  });
});

describe('findGitCommits', () => {
  it.each([
    'git status',
    'git diff HEAD',
    'git log --oneline',
    'git add src/foo.ts',
    "echo 'git commit -m foo'",
  ])('returns an empty array for non-commit git commands: %s', async (command) => {
    await expect(parseAndFindGitCommits(command)).resolves.toEqual([]);
  });

  it('detects a plain git commit invocation', async () => {
    const hits = await parseAndFindGitCommits("git commit -m 'feat: add'");

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      command: "git commit -m 'feat: add'",
      amend: false,
      startIndex: 0,
    });
  });

  it('detects git commit with the rewrite-last-commit flag variant', async () => {
    const hits = await parseAndFindGitCommits("git commit --amend -m 'fix: typo'");

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      command: "git commit --amend -m 'fix: typo'",
      amend: true,
    });
  });

  it.each([
    "git add . && git commit -m 'feat: x'",
    'echo foo | git commit --allow-empty-message',
    "echo $(git commit -m 'x')",
    "(git commit -m 'x')",
  ])('detects git commit in nested shell forms: %s', async (command) => {
    const hits = await parseAndFindGitCommits(command);

    expect(hits.length).toBeGreaterThan(0);
  });

  it('detects hyphen-dispatched git-commit', async () => {
    const hits = await parseAndFindGitCommits("git-commit -m 'feat: add'");

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      command: "git-commit -m 'feat: add'",
      amend: false,
    });
  });

  it.each(['git log | grep commit', "git log --format='%s' | grep 'commit'"])(
    'returns an empty array for pipe-to-grep string mentions: %s',
    async (command) => {
      await expect(parseAndFindGitCommits(command)).resolves.toEqual([]);
    },
  );
});
