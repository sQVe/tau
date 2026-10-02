export interface Snippet {
  /** Markdown filename without `.md`, such as `ask-questions`. Listed as `#ask-questions`. */
  id: string;
  name: string;
  description: string;
  body: string;
}
