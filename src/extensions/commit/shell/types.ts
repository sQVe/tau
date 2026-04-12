import type { Point, Tree } from 'web-tree-sitter';

export type ShellAst = Tree;

export interface GitCommitHit {
  command: string;
  startIndex: number;
  endIndex: number;
  startPosition: Point;
  endPosition: Point;
  amend: boolean;
}
