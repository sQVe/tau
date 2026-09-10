import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { openSnippetMenu } from './menu.js';
import type { Snippet } from './types.js';

const escape = '';
const enter = '\r';
const space = ' ';
const down = '[B';
const tab = '\t';

const createSnippet = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: 'example.md',
  name: 'Example',
  description: 'An example snippet',
  placement: 'append',
  order: 10,
  body: 'Example body.',
  ...overrides,
});

interface Menu {
  render: (width: number) => string[];
  press: (key: string) => void;
  selected: Promise<Set<string> | null>;
  isPending: () => boolean;
}

interface MenuComponent {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
}

/**
 * The `custom` promise settles only when the component calls `done`, as in Pi.
 * This distinguishes keys that close the menu from keys it ignores.
 */
const openMenu = (snippets: Snippet[], enabled: string[] = [], rows = 60): Menu => {
  // A holder keeps the component readable after the factory assigns it inside
  // the promise, which a plain variable would narrow away.
  const holder: { component?: MenuComponent } = {};
  let settled = false;

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const context = {
    mode: 'tui',
    ui: {
      theme,
      custom: async <T>(
        factory: (
          terminalUI: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: T) => void,
        ) => MenuComponent,
      ) =>
        new Promise<T>((resolve) => {
          holder.component = factory(
            { requestRender: () => {}, terminal: { rows } },
            theme,
            {},
            (value) => {
              settled = true;

              resolve(value);
            },
          );
        }),
    },
  } as unknown as ExtensionContext;

  const selected = openSnippetMenu(context, snippets, new Set(enabled));
  const component = holder.component;

  if (component === undefined) {
    throw new Error('The menu never built a component');
  }

  return {
    render: (width: number) => component.render(width),
    press: (key: string) => component.handleInput?.(key),
    selected,
    isPending: () => !settled,
  };
};

const manySnippets = Array.from({ length: 40 }, (_, index) =>
  createSnippet({
    id: `snippet-${index}.md`,
    name: `Snippet ${index}`,
    placement: index % 2 === 0 ? 'prepend' : 'append',
    order: index,
  }),
);

describe('openSnippetMenu', () => {
  it('resolves to the toggled ids when the user presses enter', async () => {
    const menu = openMenu([createSnippet({ id: 'first.md', name: 'First' })]);

    menu.press(space);
    menu.press(enter);

    expect(await menu.selected).toEqual(new Set(['first.md']));
  });

  it('resolves to null and discards the toggles when the user presses escape', async () => {
    const menu = openMenu([createSnippet({ id: 'first.md', name: 'First' })]);

    menu.press(space);
    menu.press(escape);

    expect(await menu.selected).toBeNull();
  });

  it('stays open while the user presses keys it does not handle', () => {
    const menu = openMenu([createSnippet({ id: 'first.md', name: 'First' })]);

    menu.press('x');
    menu.press(down);

    expect(menu.isPending()).toBe(true);
  });

  it('keeps the ids that were already enabled', async () => {
    const menu = openMenu(
      [
        createSnippet({ id: 'first.md', name: 'First', placement: 'prepend' }),
        createSnippet({ id: 'second.md', name: 'Second' }),
      ],
      ['second.md'],
    );

    menu.press(enter);

    expect(await menu.selected).toEqual(new Set(['second.md']));
  });

  it('shows the toggle in the list after the key is pressed', () => {
    const menu = openMenu([createSnippet({ id: 'first.md', name: 'First' })]);

    expect(menu.render(80).join('\n')).toContain('[ ] First');

    menu.press(space);

    expect(menu.render(80).join('\n')).toContain('[x] First');
  });

  it('moves the cursor with j and k', () => {
    const menu = openMenu([
      createSnippet({ id: 'first.md', name: 'First' }),
      createSnippet({ id: 'second.md', name: 'Second' }),
    ]);

    expect(menu.render(80).join('\n')).toContain('> [ ] First');

    menu.press('j');

    expect(menu.render(80).join('\n')).toContain('> [ ] Second');

    menu.press('k');

    expect(menu.render(80).join('\n')).toContain('> [ ] First');
  });

  it('jumps to the last snippet with G and back with g', () => {
    // The menu lists prepends before appends, so the last row is the last
    // append rather than the last entry of the fixture.
    const lastRow = manySnippets.findLast((snippet) => snippet.placement === 'append');
    const firstRow = manySnippets.find((snippet) => snippet.placement === 'prepend');
    const menu = openMenu(manySnippets);

    menu.press('G');

    expect(menu.render(80).join('\n')).toContain(`> [ ] ${lastRow?.name}`);

    menu.press('g');

    expect(menu.render(80).join('\n')).toContain(`> [ ] ${firstRow?.name}`);
  });

  it.for([20, 40, 80])('keeps every line within a width of %i', (width) => {
    const menu = openMenu(manySnippets);

    for (const line of menu.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  // Six lines of frame plus one of content is the floor; below that nothing fits.
  it.for([8, 10, 12, 20, 60])('never renders more lines than a %i row terminal', (rows) => {
    const menu = openMenu(manySnippets, [], rows);

    expect(menu.render(80).length).toBeLessThanOrEqual(rows);
  });

  it('clips a long list to the viewport and counts the hidden rows', () => {
    const menu = openMenu(manySnippets, [], 20);
    const lines = menu.render(80);
    const body = lines.join('\n');

    expect(lines.length).toBeLessThanOrEqual(20);
    expect(body).toContain('more');
  });

  it('scrolls the list down to keep the cursor visible', () => {
    const menu = openMenu(manySnippets, [], 20);
    menu.render(80);

    for (let step = 0; step < 30; step += 1) {
      menu.press(down);
    }

    const body = menu.render(80).join('\n');

    expect(body).toContain('↑');
    expect(body).toContain('> [ ]');
  });

  it('previews the selected snippet and returns to the list', () => {
    const menu = openMenu([
      createSnippet({ id: 'first.md', name: 'First', body: 'The full body text.' }),
    ]);

    menu.press(tab);

    const preview = menu.render(80).join('\n');

    expect(preview).toContain('Preview: First');
    expect(preview).toContain('The full body text.');

    menu.press(escape);

    expect(menu.render(80).join('\n')).toContain('Prompt snippets');
    expect(menu.isPending()).toBe(true);
  });
});
