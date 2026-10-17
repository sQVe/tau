import { expect, it } from 'vitest';

import { importPattern, importsModule } from './evidenceDecisions.js';

it.each([
  {
    name: 'a string that holds slashes',
    text: `const text = "a // b"; require('./a.js');`,
  },
  {
    name: 'a single-quoted string that holds slashes',
    text: `const text = 'a // b'; require('./a.js');`,
  },
  {
    name: 'a template string that holds slashes',
    text: "const text = `a // b`; require('./a.js');",
  },
  {
    name: 'a string that holds an escaped quote and slashes',
    text: `const text = "a \\" // b"; require('./a.js');`,
  },
])('reads the import that follows $name', ({ text }) => {
  expect(importsModule('src/use.ts', text, 'src/a.ts')).toBe(true);
});

it.each([
  `const text = "x"; // require('./a.js')`,
  `const text = 'x'; // require('./a.js')`,
  `const text = "x" // require('./a.js')`,
  `// import a from './a.js';`,
  `    // import a from './a.js';`,
  ` * import a from './a.js';`,
  `/* import a from './a.js'; */`,
  `// require('./a.js')`,
  `    // require('./a.js')`,
  ` * see require('./a.js') for details`,
])('does not read an import from the comment in %s', (text) => {
  expect(importsModule('src/use.ts', text, 'src/a.ts')).toBe(false);
});

it.each([
  `}from './a.js';`,
  `}   from './a.js';`,
  `} from './a.js';`,
  `const a = require ('./a.js');`,
  `const a = await import ('./a.js');`,
  `import './a.js';`,
])('reads the import in %s', (text) => {
  expect(importsModule('src/use.ts', text, 'src/a.ts')).toBe(true);
});

it.each([
  { importer: 'src/use.ts', text: `import y from './y';`, module: 'src/x/index.ts' },
  { importer: 'src/x/use.ts', text: `import a from '../';`, module: 'src/a.ts' },
  { importer: 'src/use.ts', text: `import a from '../../../a.js';`, module: 'a.ts' },
])('does not match $text in $importer to $module', ({ importer, text, module }) => {
  expect(importsModule(importer, text, module)).toBe(false);
});

it('matches an import of a directory by its index file', () => {
  expect(importsModule('src/use.ts', `import x from './x';`, 'src/x/index.ts')).toBe(true);
});

const matchesPattern = (module: string, line: string) =>
  new RegExp(importPattern(module)).test(line);

it('finds an import of a module that is not an index file by its own name only', () => {
  expect(matchesPattern('src/a.ts', `import a from './a.js';`)).toBe(true);
  expect(matchesPattern('src/a.ts', `import src from '../src';`)).toBe(false);
});

it('finds an import of an index file by its own name or its directory name', () => {
  expect(matchesPattern('src/x/index.ts', `import x from './x';`)).toBe(true);
  expect(matchesPattern('src/x/index.ts', `import x from './index.js';`)).toBe(true);
});

it('does not read a root index file as an import of any directory', () => {
  expect(matchesPattern('index.ts', `import x from './';`)).toBe(false);
  expect(matchesPattern('index.ts', `import x from './index';`)).toBe(true);
});
