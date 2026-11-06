import { expect, it } from 'vitest';

import { typesIntoTerminal } from './guardDecision.js';

const table: { command: string; refused: boolean }[] = [
  { command: 'hc send t1 x', refused: true },
  { command: 'hc keys t1 enter', refused: true },
  { command: 'if true; then hc send t1 x; fi', refused: true },
  { command: 'if false; then :; else hc send t1 x; fi', refused: true },
  { command: 'if false; then :; elif hc keys t1 enter; then :; fi', refused: true },
  { command: 'for item in one; do hc keys t1 enter; done', refused: true },
  { command: 'while true; do hc send t1 x; done', refused: true },
  { command: '! hc send t1 x', refused: true },
  { command: '{ hc send t1 x; }', refused: true },
  { command: 'if true; then { hc keys t1 enter; }; fi', refused: true },
  { command: 'sh -c "if true; then hc send t1 x; fi"', refused: true },
  { command: 'hc --json send t1 x', refused: true },
  { command: 'hc --json keys t1 enter', refused: true },
  { command: 'hc -V --json send t1 x', refused: true },
  { command: 'hc send -- t1 --help', refused: true },
  { command: 'hc send t1 -- -h', refused: true },
  { command: 'cd x && hc send t1 x', refused: true },
  { command: "sh -c 'hc send t1 x'", refused: true },
  { command: 'bash -c "hc keys t1 enter"', refused: true },
  { command: "bash -lc 'cd x; hc send t1 x'", refused: true },
  { command: 'sh -c "bash -c \'hc keys t1 enter\'"', refused: true },
  { command: '/usr/local/bin/hc send t1 x', refused: true },
  { command: 'HC_SESSION=main hc send t1 x', refused: true },
  { command: 'echo $(hc send t1 x)', refused: true },
  { command: 'hc interrupt t1', refused: false },
  { command: 'hc send --help', refused: false },
  { command: 'echo hc send', refused: false },
  { command: "printf '%s' 'hc send'", refused: false },
  { command: "cat <<'EOF'\nhc send t1 x\nEOF", refused: false },
  { command: "sh -c 'echo hc send'", refused: false },
  { command: 'hc get t1', refused: false },
  { command: 'hc send -h', refused: false },
  { command: 'hc --json send --help', refused: false },
  { command: 'if true; then echo hc send; fi', refused: false },
  { command: 'hc', refused: false },
  { command: 'git send t1 x', refused: false },
  { command: "grep -c 'hc send t1 x' notes.txt", refused: false },
  { command: "bash script.sh 'hc send t1 x'", refused: false },
  { command: "hc send t1 'unterminated", refused: false },
];

it('refuses hc send and hc keys only in command position', () => {
  const decided = table.map(({ command }) => ({ command, refused: typesIntoTerminal(command) }));

  expect(decided).toEqual(table);
});
