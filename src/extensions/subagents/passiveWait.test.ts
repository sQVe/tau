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
  {
    command: "git commit -m 'avoid while true; do sleep 60; done'",
    workers: false,
    refused: false,
  },
  { command: "bash -c 'gh run watch'", workers: false, refused: true },
  {
    command: "bash -lc 'while true; do gh pr checks; sleep 5; done'",
    workers: false,
    refused: true,
  },
  {
    command: 'while read -r item; do upload "$item"; sleep 1; done < items.txt',
    workers: false,
    refused: false,
  },
  {
    command: 'cat items | while IFS= read -r item; do echo "$item"; sleep 1; done',
    workers: false,
    refused: false,
  },
  { command: 'until read -r item; do sleep 1; done', workers: false, refused: true },
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
  {
    command: "cat <<'EOF' > demo.sh\necho \"don't wait\"\nsleep 600\nEOF\nchmod +x demo.sh",
    workers: true,
    refused: false,
  },
  { command: 'cat <<-EOF > demo.sh\n\tsleep 600\n\tEOF', workers: true, refused: false },
  { command: 'cat << "EOF" > demo.sh\nsleep 600', workers: true, refused: false },
  { command: 'cat <<EOF > demo.sh\nwait\nEOF\nsleep 600', workers: true, refused: true },
  { command: "bash <<'EOF'\nsleep 600\nEOF", workers: true, refused: true },
  { command: 'echo "sleep 600"', workers: true, refused: false },
  { command: 'echo "$(sleep 600)"', workers: true, refused: true },
  { command: 'echo "`sleep 600`"', workers: true, refused: true },
  { command: 'cat <<EOF > out.txt\n$(sleep 600)\nEOF', workers: true, refused: true },
  { command: "cat <<'EOF' > demo.sh\n$(sleep 600)\nEOF", workers: true, refused: false },
  { command: "bash >/dev/null <<'EOF'\nsleep 600\nEOF", workers: true, refused: true },
  { command: 'cat <<EOF > out.txt; echo $(sleep 20)\nok\nEOF', workers: true, refused: false },
  { command: 'cat <<EOF | bash\nsleep 600\nEOF', workers: true, refused: true },
  { command: "bash <<<'sleep 600'", workers: true, refused: true },
  { command: "/bin/bash <<'EOF'\nsleep 600\nEOF", workers: true, refused: true },
  { command: "dash <<'EOF'\nsleep 600\nEOF", workers: true, refused: true },
  { command: "echo 'sleep 600' | bash", workers: true, refused: true },
  { command: "cat <<'EOF' > demo.sh\nsleep 600\nEOF\nbash demo.sh", workers: true, refused: true },
  { command: 'echo "\\$(sleep 600)"', workers: true, refused: false },
  { command: 'echo "$(echo \')\' ; sleep 600)"', workers: true, refused: true },
  { command: 'echo "$(echo "x"; sleep 600)"', workers: true, refused: true },
  { command: '"bash" <<\'EOF\'\nsleep 600\nEOF', workers: true, refused: true },
  { command: "'/bin/sh' <<<'sleep 600'", workers: true, refused: true },
  { command: 'echo "\\\\$(sleep 600)"', workers: true, refused: true },
  { command: "echo \\'$(sleep 600)\\'", workers: true, refused: true },
  { command: "eval 'sleep 600'", workers: true, refused: true },
  { command: 'cat <<EOF | source /dev/stdin\nsleep 600\nEOF', workers: true, refused: true },
  { command: "fish -c 'sleep 600'", workers: true, refused: true },
  { command: '"$SHELL" <<\'EOF\'\nsleep 600\nEOF', workers: true, refused: true },
  {
    command: 'git commit -m "$(cat <<\'EOF\'\nfix: drop the sleep 600 retry\nEOF\n)"',
    workers: true,
    refused: false,
  },
  { command: "git commit -m 'drop the sleep 600 retry'", workers: true, refused: false },
  { command: "echo '<<EOF'\nsleep 600", workers: true, refused: true },
  { command: "echo '<<EOF'\ngh run watch", workers: false, refused: true },
  { command: 'echo "$(gh run watch)"', workers: false, refused: true },
  {
    command: 'git commit -m "$(cat <<\'EOF\'\nadd gh run watch\nEOF\n)"',
    workers: false,
    refused: false,
  },
  { command: 'sleep 30', workers: true, refused: true },
  { command: 'sleep 29', workers: true, refused: false },
  { command: 'sleep 0.5m', workers: true, refused: true },
  { command: 'sleep 0.51m', workers: true, refused: true },
  { command: 'sleep 25.55', workers: true, refused: false },
  { command: "sleep '0.'600", workers: true, refused: false },
  { command: 'sleep  40', workers: true, refused: true },
  { command: 'sleep 20 20', workers: true, refused: true },
  { command: 'cat <<\'EOF\' | "bash"\nsleep 600\nEOF', workers: true, refused: true },
  { command: "cat <<'EOF' > $(sleep 600)\nx\nEOF", workers: true, refused: true },
  { command: `echo '<<"E" sleep 600' 'x'`, workers: true, refused: false },
  { command: "echo '<<E\nx' 'sleep 600'", workers: true, refused: false },
  { command: 'printf ok # sleep 600', workers: true, refused: false },
  { command: 'git status\n# sleep 600\nls', workers: true, refused: false },
  { command: ' # sleep 600', workers: true, refused: false },
  { command: 'ls # see <<EOF\nsleep 600', workers: true, refused: true },
  { command: 'sleep 600 # wait', workers: true, refused: true },
  { command: "bash -c 'sleep 600'", workers: true, refused: true },
  { command: 'echo a#b; sleep 600', workers: true, refused: true },
  { command: 'echo a\\ #b; sleep 600', workers: true, refused: true },
  { command: 'echo "# x"; sleep 600', workers: true, refused: true },
  { command: 'ls # while true; do sleep 60; done', workers: false, refused: false },
  { command: 'echo a\r#b; sleep 600', workers: true, refused: true },
  { command: 'cat <<EOF # sleep 600\nx\nEOF', workers: true, refused: false },
  { command: 'cat <<EOF#x; sleep 600\nx\nEOF', workers: true, refused: true },
  { command: 'printf ok \\\n# sleep 600', workers: true, refused: false },
  { command: 'echo a\\\n#b; sleep 600', workers: true, refused: true },
  { command: '\\\n# sleep 600', workers: true, refused: false },
  { command: 'echo a\\\n\\\n#b; sleep 600', workers: true, refused: true },
  { command: 'echo a\\ \\\n#b; sleep 600', workers: true, refused: true },
  { command: 'printf ok \\\n\\\n# sleep 600', workers: true, refused: false },
  { command: 'echo \\ #b # sleep 600', workers: true, refused: false },
  { command: 'echo \\ #b # gh run watch', workers: false, refused: false },
  { command: 'echo \\ #a\\\n#b; sleep 600', workers: true, refused: true },
  { command: 'ls # x\\\nsleep 600', workers: true, refused: true },
  { command: 'ls #sleep 600', workers: true, refused: false },
  { command: "echo $'foo\\' # text'; sleep 600", workers: true, refused: true },
  { command: "printf %s $'it\\'s' # comment\nsleep 31", workers: true, refused: true },
  { command: 'shopt -s extglob\necho @(#foo); sleep 600', workers: true, refused: true },
  { command: '(# sleep 600\necho in)', workers: true, refused: false },
  { command: '(# sleep 600\necho hi!)', workers: true, refused: false },
  { command: 'echo @ # sleep 600', workers: true, refused: false },
  { command: `echo "$(printf '%s' "a # x"; sleep 600)"`, workers: true, refused: true },
  { command: 'echo a# ; sleep 600', workers: true, refused: true },
  { command: 'echo \\ #b; sleep 600', workers: true, refused: true },
  { command: 'echo "# $(echo hi) sleep 600"', workers: true, refused: false },
  { command: 'echo "$(sleep 600)" # x', workers: true, refused: true },
  { command: "echo 'x; sleep 600", workers: true, refused: true },
  { command: "echo 'x; sleep 6", workers: true, refused: false },
  { command: "echo 'x; gh run watch", workers: false, refused: true },
  { command: "echo 'x; gh run view", workers: false, refused: false },
  { command: 'while true; do ls; done; sleep 1', workers: false, refused: false },
  { command: 'while true; do ls; done', workers: false, refused: false },
  { command: 'aws logs tail /aws/x', workers: false, refused: false },
  { command: 'gh pr view 12 --watch', workers: false, refused: false },
  { command: "printf '%s %s\\n' 'sleep' '600'", workers: true, refused: false },
  { command: 'echo sleep 600', workers: true, refused: false },
  { command: 'nohup sleep 600', workers: true, refused: true },
  { command: 'FOO=1 sleep 600', workers: true, refused: true },
  { command: 'timeout 700 sleep 600', workers: true, refused: true },
  { command: '2>/dev/null sleep 600', workers: true, refused: true },
  { command: '> /dev/null sleep 600', workers: true, refused: true },
  { command: 'timeout -s KILL 700 sleep 600', workers: true, refused: true },
  { command: 'sudo sleep 600', workers: true, refused: true },
  { command: 'xargs sleep 600', workers: true, refused: true },
  { command: 'echo sleep 600 | bash', workers: true, refused: true },
  { command: 'echo $(sleep 15); bash -c true', workers: true, refused: false },
  { command: 'bash -c "echo $(sleep 20)"', workers: true, refused: false },
  { command: "sleep 20; bash -c 'sleep 20'", workers: true, refused: true },
  { command: "sleep 20; bash -c 'echo $(sleep 20)'", workers: true, refused: true },
  { command: "sleep 20; echo 'echo $(sleep 20)' | bash", workers: true, refused: true },
  {
    command: "bash -c 'while true; do gh pr checks; sleep 5; done'",
    workers: false,
    refused: true,
  },
  { command: 'sleep 60.', workers: true, refused: true },
  { command: 'sleep 30.5e0', workers: true, refused: true },
  { command: 'sleep .5m', workers: true, refused: true },
  { command: 'sleep 3e1', workers: true, refused: true },
  { command: 'sleep 2e1', workers: true, refused: false },
  { command: 'sleep infinity', workers: true, refused: true },
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

it.each([
  { name: 'a stray quote before 20 heredocs', command: `"${'cat <<EOF\nx\nEOF\n'.repeat(20)}` },
  { name: 'an unclosed quote before 1000 markers', command: `"${'<<'.repeat(1000)}` },
])('answers $name quickly', ({ command }) => {
  const start = performance.now();

  passiveWaitRefusal(command, { hasActiveWorkers: true, delegating: false });

  expect(performance.now() - start).toBeLessThan(100);
});

it.each([true, false])(
  'gives the model a refusal text when it refuses (delegating %s)',
  (delegating) => {
    const reason = passiveWaitRefusal('gh run watch', { hasActiveWorkers: false, delegating });

    expect(reason).toMatch(/\S/u);
  },
);
