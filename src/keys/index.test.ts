import { describe, expect, it } from 'vitest';

import { isBottom, isDown, isTop, isUp } from './index.js';

const arrowUp = '\u001b[A';
const arrowDown = '\u001b[B';
const home = '\u001b[H';
const end = '\u001b[F';

describe('vim navigation keys', () => {
  it.for([
    ['k', isUp],
    [arrowUp, isUp],
    ['j', isDown],
    [arrowDown, isDown],
    ['g', isTop],
    [home, isTop],
    ['G', isBottom],
    [end, isBottom],
  ])('reads %j as its direction', ([data, matches]) => {
    expect((matches as (input: string) => boolean)(data as string)).toBe(true);
  });

  it('keeps the four directions apart', () => {
    expect([isUp('j'), isDown('k'), isTop('G'), isBottom('g')]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it.for(['a', 'w', 'x', ' ', '\r', ''])('ignores the non-navigation key %j', (data) => {
    expect([isUp(data), isDown(data), isTop(data), isBottom(data)]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
