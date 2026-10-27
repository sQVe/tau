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
    { text: 'Intro\n```\ncode\n```\n#sim', offset: 23, query: 'sim' },
    { text: 'Intro\nmore\n```\ncode\n```\n#sim', offset: 28, query: 'sim' },
    { text: '```\n~~~\n```\n#sim', offset: 16, query: 'sim' },
    { text: '````\ncode\n`````\n#sim', offset: 20, query: 'sim' },
    { text: 'Ship #sim `x`', offset: 9, query: 'sim' },
    { text: '`x` #sim', offset: 8, query: 'sim' },
    { text: 'a ` `#sim', offset: 9, query: 'sim' },
    { text: 'Ship `x #sim', offset: 12, query: 'sim' },
    { text: '`a\n```\ncode\n```\n#sim `b', offset: 20, query: 'sim' },
    { text: 'Ship ``x` #sim', offset: 14, query: 'sim' },
    { text: '#\n```\ncode\n```', offset: 1, query: '' },
    { text: '> ```\n> code\n\n#simplify', offset: 23, query: 'simplify' },
    { text: '> ```\n> code\n#simplify', offset: 22, query: 'simplify' },
    { text: '> > ```\n> > code\n> #simplify', offset: 28, query: 'simplify' },
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
    { text: '> ```\n> code\n> #simplify', offset: 24 },
    { text: '> ```\n> code\n\n```\n#simplify', offset: 27 },
    { text: '> ```\n> #push\nafter', offset: 13 },
    { text: '> ```\n> code\n`#sim` x', offset: 18 },
    { text: '- Step:\n\n    ```sh\n    #push', offset: 28 },
    { text: '1. ```\n   #push', offset: 15 },
    { text: '- ```\n  run\n- ```\n  #push', offset: 25 },
    { text: '- > ```sh\n  > #push', offset: 19 },
    { text: '```\ncode\n#push', offset: 15 },
    { text: '```\n#sim\n```', offset: 8 },
    { text: 'Intro\nmore\n```\n#sim\n```', offset: 20 },
    { text: '````\ncode\n```\n#push', offset: 20 },
    { text: '```\n~~~\n#push', offset: 14 },
    { text: '~~~\ncode\n```\n#push', offset: 19 },
    { text: '```\ncode\n```\nUse `#sim` x', offset: 22 },
    { text: 'Use `#sim` x\n```\ncode\n```', offset: 9 },
    { text: 'Ship `x #sim` more', offset: 12 },
    { text: 'Ship `#` x', offset: 7 },
    { text: '`#` x', offset: 2 },
    { text: 'x ``a ` #sim` y', offset: 12 },
    { text: 'Ship ``a #sim `` b', offset: 13 },
    { text: 'Ship ``x`` `a #sim`', offset: 18 },
  ])('reads no query from $text at $offset', ({ text, offset }) => {
    expect(snippetQueryAt(text, offset)).toBeUndefined();
  });
});
