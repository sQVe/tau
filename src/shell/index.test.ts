import { describe, expect, it, vi } from 'vitest';
import { Language, Parser } from 'web-tree-sitter';

import { parseBash } from './index.js';

describe('parseBash', () => {
  it('returns an AST with a non-null root node for a simple command', async () => {
    const ast = await parseBash('echo hi');

    expect(ast.rootNode).not.toBeNull();
    expect(ast.rootNode.type).toBe('program');
  });

  it('tolerates an empty string without throwing', async () => {
    const ast = await parseBash('');

    expect(ast.rootNode.type).toBe('program');
  });

  it('throws a clear error when the parser returns null', async () => {
    const parseSpy = vi
      .spyOn(Parser.prototype, 'parse')
      .mockReturnValueOnce(null as unknown as ReturnType<Parser['parse']>);

    try {
      await expect(parseBash('echo hi')).rejects.toThrow(/failed to parse/i);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('reuses the same parser instance across successive calls', async () => {
    // Warm the singleton before spying so init/load calls are attributed to setup, not the test.
    await parseBash('echo warm');

    const initSpy = vi.spyOn(Parser, 'init');
    const loadSpy = vi.spyOn(Language, 'load');

    try {
      await Promise.all([parseBash('echo one'), parseBash('echo two'), parseBash('echo three')]);

      expect(initSpy).not.toHaveBeenCalled();
      expect(loadSpy).not.toHaveBeenCalled();
    } finally {
      initSpy.mockRestore();
      loadSpy.mockRestore();
    }
  });
});
