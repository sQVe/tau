import { describe, expect, it } from 'vitest';

import { snippetQueryAt } from './query.js';

describe('snippetQueryAt', () => {
  it.each([
    { text: '#sim', offset: 4, query: 'sim' },
    { text: 'Ship #push-b', offset: 12, query: 'push-b' },
    { text: 'Ship (#sim', offset: 10, query: 'sim' },
    { text: 'Ship\n#sim later', offset: 9, query: 'sim' },
    { text: 'Ship `#sim', offset: 10, query: 'sim' },
    { text: '> ```sh\n> run\n> ```\n#push', offset: 25, query: 'push' },
    { text: '- ```\n  run\n  ```\n#push', offset: 23, query: 'push' },
    { text: '#', offset: 1, query: '' },
    { text: 'Ship (#', offset: 7, query: '' },
  ])('reads $query from $text', ({ text, offset, query }) => {
    expect(snippetQueryAt(text, offset)).toBe(query);
  });

  it.each([
    { text: '# ', offset: 2 },
    { text: 'a#sim', offset: 5 },
    { text: '#sim.', offset: 5 },
    { text: 'Ship it', offset: 7 },
    { text: '`#sim` here', offset: 5 },
    { text: '```\n#sim', offset: 8 },
    { text: '> ```sh\n> #push', offset: 15 },
    { text: '- Step:\n\n    ```sh\n    #push', offset: 28 },
    { text: '1. ```\n   #push', offset: 15 },
    { text: '- ```\n  run\n- ```\n  #push', offset: 25 },
    { text: '- > ```sh\n  > #push', offset: 19 },
  ])('reads no query from $text at $offset', ({ text, offset }) => {
    expect(snippetQueryAt(text, offset)).toBeUndefined();
  });
});
