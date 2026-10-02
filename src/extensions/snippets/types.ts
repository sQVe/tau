export interface Snippet {
  /** Markdown filename without `.md`, such as `ask-questions`. Typed as `#ask-questions`. */
  id: string;
  name: string;
  description: string;
  order: number;
  body: string;
}
