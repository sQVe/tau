export type SnippetPlacement = 'prepend' | 'append';

export interface Snippet {
  /** Markdown filename, such as `ask-questions.md`. */
  id: string;
  name: string;
  description: string;
  placement: SnippetPlacement;
  order: number;
  body: string;
}
