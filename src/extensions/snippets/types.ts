export type SnippetPlacement = 'prepend' | 'append';

export interface Snippet {
  /** Markdown filename without `.md`, such as `ask-questions`. Typed as `#ask-questions`. */
  id: string;
  name: string;
  description: string;
  placement: SnippetPlacement;
  order: number;
  body: string;
}
