import { expect, it } from 'vitest';

import { passiveWaitRefusal } from './passiveWait.js';

it.each([
  { command: 'while true; do gh pr checks; sleep 60; done', workers: false, refused: true },
  { command: 'gh run watch', workers: false, refused: true },
  { command: 'gh pr checks 12 --watch', workers: false, refused: true },
  { command: 'aws logs tail /aws/x --follow', workers: false, refused: true },
  { command: 'aws logs tail /aws/x -f', workers: false, refused: true },
  { command: 'until gh run view 1; do sleep 10; done', workers: false, refused: true },
  { command: 'watch -n 5 kubectl get pods', workers: false, refused: true },
  { command: 'cd x && watch ls', workers: false, refused: true },
  { command: 'sleep 2', workers: false, refused: false },
  { command: 'sleep 2', workers: true, refused: false },
  { command: 'for f in a b; do echo $f; done', workers: false, refused: false },
  { command: 'for f in a b; do echo $f; done', workers: true, refused: false },
  { command: "git commit -m 'add --watch flag'", workers: false, refused: false },
  { command: 'echo "gh run watch"', workers: false, refused: false },
  { command: "git commit -m 'run gh run watch later'", workers: true, refused: false },
  { command: 'gh pr checks 12', workers: false, refused: false },
  { command: 'sleep 900', workers: false, refused: false },
  { command: 'sleep 900', workers: true, refused: true },
  { command: 'sleep 20; sleep 20', workers: true, refused: true },
  { command: "bash -c 'sleep 900'", workers: true, refused: true },
  { command: "bash -c 'sleep 900'", workers: false, refused: false },
  {
    command: "bash -c 'while true; do gh pr checks; sleep 60; done'",
    workers: false,
    refused: true,
  },
  {
    command: 'while IFS= read -r line; do printf "%s\\n" "$line"; done < input.txt; sleep 2',
    workers: false,
    refused: false,
  },
  { command: 'sleep 5 && ls', workers: true, refused: false },
])('returns refusal $refused for "$command" with workers $workers', (row) => {
  const reason = passiveWaitRefusal(row.command, {
    hasActiveWorkers: row.workers,
    delegating: false,
  });

  expect(reason !== undefined).toBe(row.refused);
});

it('offers a worker for a requested wait only when delegating', () => {
  const command = 'gh run watch';
  const delegating = passiveWaitRefusal(command, { hasActiveWorkers: false, delegating: true });
  const alone = passiveWaitRefusal(command, { hasActiveWorkers: false, delegating: false });

  expect(delegating).toContain('worker');
  expect(alone).not.toContain('worker');
  expect(alone).toContain('resumes');
});
