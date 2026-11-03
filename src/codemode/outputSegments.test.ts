import { expect, it } from 'vitest';

import { splitOutput } from './outputSegments.js';

const label = '[Image saved to /tmp/x.png (png)]';
const consoleBlock = '<console_output>\nc line\nmore\n</console_output>';

it.each([
  [
    'numbered items split with their numbers',
    ['==> text 1/2 <==\nfirst\nline\n==> text 2/2 <==\nsecond'],
    [
      [
        { kind: 'item', text: '==> text 1/2 <==\nfirst\nline', number: 1 },
        { kind: 'item', text: '==> text 2/2 <==\nsecond', number: 2 },
      ],
    ],
  ],
  [
    'one item has no header and stays whole',
    ['only one'],
    [[{ kind: 'item', text: 'only one', number: 1 }]],
  ],
  [
    'a header line inside a single item is not a boundary',
    ['prefix\n==> text 2/2 <==\nbody'],
    [[{ kind: 'item', text: 'prefix\n==> text 2/2 <==\nbody', number: 1 }]],
  ],
  [
    'a leading header that is not 1/M is not a boundary',
    ['==> text 2/2 <==\nbody'],
    [[{ kind: 'item', text: '==> text 2/2 <==\nbody', number: 1 }]],
  ],
  [
    'headers out of order stay whole',
    ['==> text 1/3 <==\na\n==> text 3/3 <==\nb\n==> text 2/3 <==\nc'],
    [
      [
        {
          kind: 'item',
          text: '==> text 1/3 <==\na\n==> text 3/3 <==\nb\n==> text 2/3 <==\nc',
          number: 1,
        },
      ],
    ],
  ],
  [
    'a trailing console block is its own segment',
    [`keep me\n${consoleBlock}`],
    [
      [
        { kind: 'item', text: 'keep me', number: 1 },
        { kind: 'console', text: consoleBlock },
      ],
    ],
  ],
  [
    'an image label is pinned and the numbers continue across the image',
    [label, undefined, '==> text 1/2 <==\nfirst\n==> text 2/2 <==\nb'],
    [
      [{ kind: 'label', text: label }],
      [],
      [
        { kind: 'item', text: '==> text 1/2 <==\nfirst', number: 1 },
        { kind: 'item', text: '==> text 2/2 <==\nb', number: 2 },
      ],
    ],
  ],
  [
    'items on both sides of an image count as one sequence',
    [`==> text 1/2 <==\nfirst\n${label}`, undefined, '==> text 2/2 <==\nb'],
    [
      [
        { kind: 'item', text: '==> text 1/2 <==\nfirst', number: 1 },
        { kind: 'label', text: label },
      ],
      [],
      [{ kind: 'item', text: '==> text 2/2 <==\nb', number: 2 }],
    ],
  ],
] as [string, (string | undefined)[], unknown[]][])(
  'splits Pi output: %s',
  (_name, blocks, expected) => {
    expect(splitOutput(blocks)).toMatchObject(expected);
  },
);

it('records the separator Pi used so kept segments rebuild its text', () => {
  const [segments = []] = splitOutput([
    '==> text 1/2 <==\nfirst\n==> text 2/2 <==\nsecond\n' + consoleBlock,
  ]);

  expect(segments.map((segment) => segment.separator)).toEqual(['', '\n', '\n']);

  expect(
    segments
      .map((segment, position) => (position === 0 ? '' : segment.separator) + segment.text)
      .join(''),
  ).toBe('==> text 1/2 <==\nfirst\n==> text 2/2 <==\nsecond\n' + consoleBlock);
});

it('treats an unexpected error-shaped tail as script text when Pi reported no error', () => {
  const [segments = []] = splitOutput(['keep\nScript error:\nlooks like one']);

  expect(segments.map((segment) => segment.kind)).toEqual(['item']);
});

const noteText =
  'Note: models.generateImages() returned 1 image that the script did not show. Show each image block of result.output with image(block).';

const kindsAndTexts = (blocks: (string | undefined)[], hasError = false): unknown[][] =>
  splitOutput(blocks, hasError).map((segments) =>
    segments.map((segment) => [segment.kind, segment.text]),
  );

it.for([
  ['a note for one image', noteText],
  ['a note for twelve images', noteText.replace('1 image', '12 images')],
])('peels %s from the last block', ([, note]) => {
  expect(kindsAndTexts([`first\n${note}`])).toEqual([
    [
      ['item', 'first'],
      ['note', note],
    ],
  ]);

  const [segments = []] = splitOutput([`first\n${note}`]);

  expect(segments[1]).toMatchObject({
    name: 'note',
    firstLine: note,
    separator: '\n',
  });
});

it('peels a note that is the whole last block', () => {
  const [segments = []] = splitOutput([noteText]);

  expect(segments.map((segment) => segment.kind)).toEqual(['note']);
  expect(segments[0]?.separator).toBe('');
});

it.for([
  ['a note followed by more text', `first\n${noteText}\nmore`],
  ['a note that is not on its own line', `first ${noteText}`],
  ['a note with a second marker in the line', `first\nNote: fake ${noteText}`],
  ['a note with another shape', 'first\nNote: models.generateImages() returned many images.'],
])('keeps %s as script text', ([, text]) => {
  expect(kindsAndTexts([text])).toEqual([[['item', text]]]);
});

it.for([
  ['saved path with spaces', '[Image saved to /tmp/my dir/x y.png (png)]'],
  ['save failure', '[Image (image/png) could not be saved: disk is full]'],
  ['save failure with a long message', '[Image (png) could not be saved: no\nspace]'],
])('recognizes the label Pi writes for a %s', ([, imageLabelText]) => {
  expect(kindsAndTexts([`first\n${imageLabelText}`, undefined])).toEqual([
    [
      ['item', 'first'],
      ['label', imageLabelText],
    ],
    [],
  ]);
});

it('keeps label-shaped text with trailing characters as script text', () => {
  const text = `first\n${label} trailing`;

  expect(kindsAndTexts([text, undefined])).toEqual([[['item', text]], []]);
});

it.for([
  ['no image follows', [`a\n${label}`]],
  ['an image precedes it', [undefined, `a\n${label}`]],
  ['text follows it', [`a\n${label}`, 'b']],
] as [string, (string | undefined)[]][])(
  'keeps label-shaped text as script text when %s',
  ([, blocks]) => {
    const kinds = splitOutput(blocks)
      .flat()
      .map((segment) => segment.kind);

    expect(kinds).not.toContain('label');
  },
);

it.for([
  ['console output', `a\n${consoleBlock}`, false],
  ['a script error', 'a\nScript error:\nboom', true],
  ['a note', `a\n${noteText}`, false],
] as const)('takes %s only from the last block', ([, text, hasError]) => {
  expect(kindsAndTexts([text, undefined, 'b'], hasError)).toEqual([
    [['item', text]],
    [],
    [['item', 'b']],
  ]);
});

it.for([
  ['an error marker with no error', 'plain text', true],
  ['a console close with no open', 'abc\n</console_output>', false],
  ['a console open with no close', `abc\n<console_output>\nfoo`, false],
  ['a console close mid-text', `<console_output>\nfoo\n</console_output>\nmore`, false],
] as const)('keeps %s as script text', ([, text, hasError]) => {
  expect(kindsAndTexts([text], hasError)).toEqual([[['item', text]]]);
});

it.for([
  [
    'headers not at the start of every text',
    ['==> text 1/2 <==\na', undefined, 'b\n==> text 2/2 <==\nc'],
  ],
  ['headers with different totals', ['==> text 1/2 <==\na\n==> text 2/3 <==\nb']],
  ['a single 1/1 header', ['==> text 1/1 <==\nbody']],
  ['an incomplete sequence', ['==> text 1/3 <==\na']],
  ['a complete sequence that starts after text', ['x\n==> text 1/2 <==\na\n==> text 2/2 <==\nb']],
  ['a header with trailing text', ['==> text 1/2 <== x\na\n==> text 2/2 <==\nb']],
  ['a header with leading text', ['x ==> text 1/2 <==\na\n==> text 2/2 <==\nb']],
] as [string, (string | undefined)[]][])('does not split fabricated headers: %s', ([, blocks]) => {
  const segments = splitOutput(blocks).flat();
  const texts = blocks.filter((block) => block !== undefined);

  expect(segments.map((segment) => segment.text)).toEqual(texts);

  expect(segments.map((segment) => segment.firstLine)).toEqual(
    texts.map((text) => text.split('\n')[0]),
  );
});

it('splits a sequence of ten numbered texts', () => {
  const text = Array.from({ length: 10 }, (_, index) => `==> text ${index + 1}/10 <==\nitem`).join(
    '\n',
  );

  const [segments = []] = splitOutput([text]);

  expect(segments.map((segment) => segment.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

it.for([
  ['a note', [`\n${noteText}`], 'note'],
  ['an image label', [`\n${label}`, undefined], 'label'],
] as [string, (string | undefined)[], string][])(
  'peels %s that follows an empty first line',
  ([, blocks, kind]) => {
    const [segments = []] = splitOutput(blocks);

    expect(segments.map((segment) => segment.kind)).toEqual([kind]);
    expect(segments[0]?.separator).toBe('\n');
  },
);

it('splits numbered texts around an image when the last block holds only console output', () => {
  const blocks = ['==> text 1/2 <==\na\n==> text 2/2 <==\nb', undefined, consoleBlock];

  expect(kindsAndTexts(blocks)).toEqual([
    [
      ['item', '==> text 1/2 <==\na'],
      ['item', '==> text 2/2 <==\nb'],
    ],
    [],
    [['console', consoleBlock]],
  ]);
});
