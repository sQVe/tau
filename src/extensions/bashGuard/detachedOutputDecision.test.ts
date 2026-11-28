import { expect, it } from 'vitest';

import { loggedClose, nestedScript, nohupClose } from '../../../tests/bashGuardCommands.js';
import { quoteShellArgument } from '../../shell/shell.js';
import { decideDetachedOutput } from './detachedOutputDecision.js';

const blocks = (command: string): boolean =>
  decideDetachedOutput({ toolName: 'bash', command })?.block === true;

// Wraps a nested script chain in `outerDepth` foreground scripts, then backgrounds it.
const nestedBackgroundedScript = (outerDepth: number, innerDepth: number): string => {
  let script = `bash -c ${quoteShellArgument(nestedScript(innerDepth))} &`;

  for (let level = 0; level < outerDepth; level += 1) {
    script = `bash -c ${quoteShellArgument(script)}`;
  }

  return script;
};

it('blocks the past nohup close whose stderr went to /dev/null', () => {
  const decision = decideDetachedOutput({ toolName: 'bash', command: nohupClose });

  expect(decision?.block).toBe(true);
});

it('allows the logged setsid close whose inner command writes a log', () => {
  expect(decideDetachedOutput({ toolName: 'bash', command: loggedClose })).toBeUndefined();
});

// Each wrapper prefix runs the shell after it, so the guard must judge the same hidden failure.
const wrapperPrefixes: readonly (readonly [string, string])[] = [
  ['a timeout', 'timeout -k 1 5'],
  ['an env assignment', 'env FOO=1'],
  ['a leading assignment', 'FOO=1'],
  ['a negation', '!'],
  ['a doas user option', 'doas -u root'],
  ['a sudo chroot', 'sudo -R /newroot'],
  ['a time portability flag', 'time -p'],
  ['a nice adjustment', 'nice -n 5'],
  ['a stdbuf option', 'stdbuf -oL'],
  ['an xargs option', 'xargs -n 1'],
  ['a flock lock file', 'flock -w 5 /tmp/lock'],
  ['a chroot root', 'chroot /newroot'],
  ['a watch interval', 'watch -n 1'],
];

const wrapperRows = wrapperPrefixes.map(([name, prefix]) => ({
  name: `a detached script behind ${name}`,
  command: `${prefix} sh -c 'cmd 2>/dev/null' &`,
  blocked: true,
}));

it.each<{ name: string; command: string; blocked: boolean }>([
  ...wrapperRows,
  {
    name: 'a detached script behind an env split string',
    command: `env -S "sh -c 'cmd 2>/dev/null'" &`,
    blocked: true,
  },
  {
    name: 'a detached setsid behind an env split string',
    command: `env -S 'setsid -f cmd' 2>/dev/null`,
    blocked: true,
  },
  {
    name: 'a detached script behind an env value that depends on the environment',
    command: `env -S "\${SHELL} -c 'cmd 2>/dev/null'" &`,
    blocked: true,
  },
  {
    name: 'an exec inside a brace group after the group redirection',
    command: '{ exec 2>/dev/null; cmd & } 2>/tmp/x.log',
    blocked: true,
  },
  {
    name: 'an exec inside a brace group before the group discards stderr',
    command: '{ exec 2>/tmp/x.log; cmd & } 2>/dev/null',
    blocked: false,
  },
  {
    name: 'an exec inside an if after the group redirection',
    command: 'if true; then exec 2>/dev/null; cmd & fi 2>/tmp/x.log',
    blocked: true,
  },
  {
    name: 'an exec inside a while after the group redirection',
    command: 'while true; do exec 2>/dev/null; cmd & done 2>/tmp/x.log',
    blocked: true,
  },
  {
    name: 'a brace group exec that reaches a later detached command',
    command: '{ exec 2>/dev/null; }; cmd &',
    blocked: true,
  },
  {
    name: 'an exec inside a subshell after the group redirection',
    command: '( exec 2>/dev/null; cmd & ) 2>/tmp/x.log',
    blocked: true,
  },
  {
    name: 'a nested brace exec after the enclosing group redirection',
    command: '{ { exec 2>/dev/null; }; cmd & } 2>/tmp/x.log',
    blocked: true,
  },
  {
    name: 'a nested brace exec in a subshell after the group redirection',
    command: '( { exec 2>/dev/null; }; cmd & ) 2>/tmp/x.log',
    blocked: true,
  },
  {
    name: 'a nested brace exec before the enclosing group discards stderr',
    command: '{ { exec 2>/tmp/x.log; }; cmd & } 2>/dev/null',
    blocked: false,
  },
  { name: 'a detached command that keeps stderr', command: 'cmd &', blocked: false },
  {
    name: 'a detached command with stderr to /dev/null',
    command: 'cmd 2>/dev/null &',
    blocked: true,
  },
  {
    name: 'a detached command with both streams to /dev/null',
    command: 'cmd &>/dev/null &',
    blocked: true,
  },
  {
    name: 'a detached command with stderr to a doubled-slash null device',
    command: 'cmd 2>/dev//null &',
    blocked: true,
  },
  {
    name: 'a detached command with stderr to a dotted null device',
    command: 'cmd 2>/dev/./null &',
    blocked: true,
  },
  {
    name: 'a detached command with stderr to a parent-segment null device',
    command: 'cmd 2>/dev/../dev/null &',
    blocked: true,
  },
  {
    name: 'a detached command with both streams to a doubled-slash null device',
    command: 'cmd &>/dev//null &',
    blocked: true,
  },
  {
    name: 'a foreground command that discards stderr',
    command: 'cmd >/dev/null 2>&1',
    blocked: false,
  },
  {
    name: 'a detached command that logs both streams',
    command: 'cmd > /tmp/x.log 2>&1 &',
    blocked: false,
  },
  {
    name: 'a nohup command that discards stderr',
    command: 'nohup cmd >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a setsid command that discards stderr',
    command: 'setsid cmd 2>/dev/null &',
    blocked: true,
  },
  {
    name: 'a setsid fork that discards stderr without a background separator',
    command: 'setsid -f cmd 2>/dev/null',
    blocked: true,
  },
  {
    name: 'a setsid fork that logs stderr',
    command: 'setsid -f cmd 2>/tmp/x.log',
    blocked: false,
  },
  {
    name: 'a setsid without fork that discards stderr',
    command: 'setsid cmd 2>/dev/null',
    blocked: false,
  },
  {
    name: 'a setsid long options before fork that discards stderr',
    command: 'setsid --ctty --fork cmd 2>/dev/null',
    blocked: true,
  },
  {
    name: 'a setsid short options before fork that discards stderr',
    command: 'setsid -c -f cmd 2>/dev/null',
    blocked: true,
  },
  {
    name: 'a backgrounded shell that reads its script from a here-string',
    command: `bash <<< 'nohup app 2>/dev/null' &`,
    blocked: true,
  },
  {
    name: 'a detached pipeline whose middle element discards the merged stream',
    command: 'cmd 2>&1 | cat >/dev/null | cat &',
    blocked: true,
  },
  {
    name: 'a detached command after a group that restores stderr through an unnumbered ampersand',
    command: '{ exec 2>/dev/null; } >& /tmp/x.log; nohup app &',
    blocked: false,
  },
  {
    name: 'a detached shell that runs a script file it cannot inspect',
    command: 'bash script.sh &',
    blocked: true,
  },
  {
    name: 'a detached shell whose heredoc is not the script because a file operand wins',
    command: "bash script.sh <<'EOF' &\nnohup app > /tmp/x.log 2>&1\nEOF",
    blocked: true,
  },
  {
    name: 'a backgrounded shell that reads its script from a heredoc',
    command: "bash <<'EOF' &\nnohup app 2>/dev/null\nEOF",
    blocked: true,
  },
  {
    name: 'a backgrounded shell whose heredoc script logs its stderr',
    command: "bash <<'EOF' &\nnohup app > /tmp/x.log 2>&1\nEOF",
    blocked: false,
  },
  { name: 'a detached append to /dev/null', command: 'cmd >>/dev/null 2>&1 &', blocked: true },
  {
    name: 'a detached command with an unnumbered ampersand to /dev/null',
    command: 'cmd >&/dev/null &',
    blocked: true,
  },
  {
    name: 'a detached pipeline whose first command discards stderr',
    command: 'cmd 2>/dev/null | cat &',
    blocked: true,
  },
  {
    name: 'a detached script that closes its stderr descriptor',
    command: "sh -c 'printf hidden >&2; false 2>&-' >/dev/null 2>&1 &",
    blocked: true,
  },
  {
    name: 'a detached command that logs both streams through an unnumbered ampersand',
    command: 'cmd >& /tmp/x.log &',
    blocked: false,
  },
  {
    name: 'a detached command that closes its stderr descriptor',
    command: 'cmd 2>&- &',
    blocked: true,
  },
  {
    name: 'a detached command before another command',
    command: 'cmd 2>/dev/null & echo done',
    blocked: true,
  },
  {
    name: 'a detached shell script with no inner redirect',
    command: "sh -c 'cmd' >/dev/null 2>&1 &",
    blocked: true,
  },
  {
    name: 'a detached shell script whose last command logs',
    command: "bash -c 'sleep 1; cmd > /tmp/x.log 2>&1' >/dev/null 2>&1 &",
    blocked: false,
  },
  {
    name: 'a detached setsid script whose inner command writes a log',
    command: loggedClose,
    blocked: false,
  },
  {
    name: 'a foreground pipeline that merges stderr into the pipe',
    command: 'printf example 2>/dev/null |& cat',
    blocked: false,
  },
  {
    name: 'a command lookup of an env value that depends on the environment',
    command: `command -v env -S \${SHELL}`,
    blocked: false,
  },
  {
    name: 'a detached group whose command logs and whose group discards stderr',
    command: '( cmd > /tmp/x.log 2>&1 ) >/dev/null 2>&1 &',
    blocked: false,
  },
  {
    name: 'a detached group whose command does not log',
    command: '( herdr-app do space.close --confirmed ) >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a detached group whose own redirection logs',
    command: '( cmd ) > /tmp/x.log 2>&1 &',
    blocked: false,
  },
  {
    name: 'a detached group whose own redirection discards stderr',
    command: '( cmd ) >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a nested backgrounded group whose only real command logs',
    command: '( ( cmd > /tmp/x.log 2>&1 ) & ) >/dev/null 2>&1',
    blocked: false,
  },
  {
    name: 'a nested backgrounded group that inherits a discarded stderr',
    command: '( ( cmd ) & ) >/dev/null 2>&1',
    blocked: true,
  },
  {
    name: 'a backgrounded script that inherits a discarded stderr',
    command: "( sh -c 'cmd' & ) >/dev/null 2>&1",
    blocked: true,
  },
  {
    name: 'a detached |& pipeline that merges stderr into the pipe',
    command: 'cmd 2>/dev/null |& cat &',
    blocked: false,
  },
  {
    name: 'a detached pipeline that merges stderr into a consumer discarding it',
    command: 'cmd 2>&1 | cat >/dev/null &',
    blocked: true,
  },
  {
    name: 'a detached |& pipeline whose consumer discards the merged stream',
    command: 'cmd 2>&1 |& cat >/dev/null &',
    blocked: true,
  },
  {
    name: 'a detached pipeline that merges stderr into a consumer logging it',
    command: 'cmd 2>&1 | cat > /tmp/x.log &',
    blocked: false,
  },
  {
    name: 'a detached pipeline whose consumer redirects stderr after the merge',
    command: 'cmd 2>&1 | cat 2>/dev/null &',
    blocked: true,
  },
  {
    name: 'a detached pipeline whose group redirect wins over the pipe target',
    command: '( cmd 2>&1 ) >/dev/null | cat &',
    blocked: true,
  },
  {
    name: 'a shell discarding inner stderr',
    command: `sh -c 'sh -c "printf hidden >&2; exit 17" 2>/dev/null' &`,
    blocked: true,
  },
  {
    name: 'a shell with a later inner discard',
    command: `sh -c 'true; cmd 2>/dev/null' &`,
    blocked: true,
  },
  {
    name: 'a shell cluster whose script logs',
    command: `nohup bash -lc 'cmd > /tmp/x.log 2>&1' >/dev/null 2>&1 &`,
    blocked: false,
  },
  {
    name: 'a shell script whose logging command is followed by a silent one',
    command: `setsid sh -c 'cmd > /tmp/x.log 2>&1; true' >/dev/null 2>&1 &`,
    blocked: true,
  },
  {
    name: 'a shell script whose last command inherits the discarded stderr',
    command: `sh -c 'echo start > /tmp/x.log 2>&1; cmd' >/dev/null 2>&1 &`,
    blocked: true,
  },
  {
    name: 'a shell script whose inner group discards stderr',
    command: `sh -c '( cmd ) 2>/dev/null' &`,
    blocked: true,
  },
  {
    name: 'a shell script whose inner group logs stderr',
    command: `sh -c '( cmd ) > /tmp/x.log 2>&1' >/dev/null 2>&1 &`,
    blocked: false,
  },
  {
    name: 'a detached group whose first command discards stderr and a later one logs',
    command:
      '( herdr-app do space.close --confirmed 2>/dev/null; echo done > /tmp/x.log 2>&1 ) >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a detached group whose last command inherits the discard',
    command:
      '( herdr-app do space.close --confirmed > /tmp/x.log 2>&1; sleep 1 ) >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a detached group whose last command logs',
    command: '( close; true > /tmp/x.log 2>&1 ) >/dev/null 2>&1 &',
    blocked: false,
  },
  {
    name: 'a detached command backgrounded inside a foreground group',
    command: '( cmd 2>/dev/null & )',
    blocked: true,
  },
  {
    name: 'a shell script whose nested script discards stderr',
    command: `sh -c 'sh -c "cmd 2>/dev/null"' &`,
    blocked: true,
  },
  {
    name: 'a heredoc body command before a background unit',
    command: 'cat <<EOF\n$(touch x 2>/dev/null)\nEOF\nother &',
    blocked: false,
  },
  {
    name: 'a heredoc body that follows a continued line',
    command: 'cat <<EOF &&\ncmd 2>/dev/null &\nEOF\necho done',
    blocked: false,
  },
  {
    name: 'a heredoc body command inside a backtick before a background unit',
    command: 'echo `cat <<EOF\n$(touch x 2>/dev/null)\nEOF` &',
    blocked: true,
  },
  {
    name: 'a heredoc body command inside a command substitution before a background unit',
    command: 'echo $(cat <<EOF\n$(touch x 2>/dev/null)\nEOF\n) &',
    blocked: true,
  },
  {
    name: 'stderr duplicated from an inherited descriptor',
    command: 'cmd 2>&3 3>/dev/null &',
    blocked: true,
  },
  {
    name: 'stderr duplicated from a descriptor discarded before the duplication',
    command: 'cmd 3>/dev/null 2>&3 &',
    blocked: true,
  },
  {
    name: 'a detached command whose argument mentions a shell',
    command: "echo sh -c 'cmd 2>/dev/null' &",
    blocked: false,
  },
  {
    name: 'a detached ksh script that discards stderr',
    command: "ksh -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached script at a path',
    command: "/bin/sh -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached script whose inner command closes stderr',
    command: `sh -c 'cmd 2>&-' > /tmp/x.log 2>&1 &`,
    blocked: true,
  },
  {
    name: 'a detached append of both streams to /dev/null',
    command: 'cmd &>>/dev/null &',
    blocked: true,
  },
  {
    name: 'a detached append of both streams to a log',
    command: 'cmd &>>/tmp/x.log &',
    blocked: false,
  },
  {
    name: 'a detached script behind a sudo login class',
    command: "sudo -c staff sh -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached script behind a sudo long login class',
    command: "sudo --login-class staff sh -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached script behind a sudo auth type',
    command: "sudo -a pam sh -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached script behind a sudo long auth type',
    command: "sudo --auth-type pam sh -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached script behind a doas auth type',
    command: "doas -a style sh -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached flock script option before the lock file',
    command: "flock -c 'cmd 2>/dev/null' /tmp/lock &",
    blocked: true,
  },
  {
    name: 'a detached flock script option after the lock file',
    command: "flock /tmp/lock -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached watch script',
    command: "watch -n 1 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached script behind an if keyword',
    command: "if sh -c 'cmd 2>/dev/null'; then echo ok; fi &",
    blocked: true,
  },
  {
    name: 'a detached script behind a brace keyword',
    command: "{ sh -c 'cmd 2>/dev/null'; } &",
    blocked: true,
  },
  {
    name: 'a command lookup of a shell',
    command: "command -v sh -c 'cmd 2>/dev/null' &",
    blocked: false,
  },
  {
    name: 'a detached script the parser cannot parse',
    command: `sh -c "echo 'unterminated" > /tmp/x.log 2>&1 &`,
    blocked: true,
  },
  {
    name: 'a nested group whose outer redirection keeps stderr visible',
    command: '( ( cmd 1>&2 ) ) 2>&1 1>/dev/null &',
    blocked: false,
  },
  {
    name: 'a nested group whose inner redirection discards stderr and whose outer logs',
    command: '{ { cmd & } 2>/dev/null; } 2>/tmp/x.log',
    blocked: true,
  },
  {
    name: 'a nested group whose inner redirection logs and whose outer discards stderr',
    command: '{ { cmd & } 2>/tmp/x.log; } 2>/dev/null',
    blocked: false,
  },
  {
    name: 'a paren group whose inner redirection discards stderr and whose outer logs',
    command: '( { cmd & } 2>/dev/null ) 2>/tmp/x.log',
    blocked: true,
  },
  {
    name: 'a detached pipeline broken across a newline whose first command discards stderr',
    command: 'nohup cmd 2>/dev/null |\n  cat &',
    blocked: true,
  },
  {
    name: 'a foreground command before a substitution with an inner background command',
    command: 'printf example 2>/dev/null; printf "%s" "$(true &)"',
    blocked: false,
  },
  {
    name: 'a detached and-list broken across a newline whose first command discards stderr',
    command: 'nohup cmd 2>/dev/null &&\n  other &',
    blocked: true,
  },
  {
    name: 'a detached or-list broken across a newline whose first command discards stderr',
    command: 'nohup cmd 2>/dev/null ||\n  other &',
    blocked: true,
  },
  {
    name: 'a foreground and-list broken across a newline',
    command: 'cmd 2>/dev/null &&\n  other',
    blocked: false,
  },
  {
    name: 'a detached and-list before a backgrounded brace compound',
    command: 'a 2>/dev/null && { b; } &',
    blocked: true,
  },
  {
    name: 'a backgrounded brace compound before an and-list',
    command: '{ b 2>/dev/null; } && c &',
    blocked: true,
  },
  {
    name: 'a detached and-list after a separator before a brace compound',
    command: 'a; b 2>/dev/null && { c; } &',
    blocked: true,
  },
  {
    name: 'a detached flock script given inline',
    command: "flock --command='cmd 2>/dev/null' /tmp/lock &",
    blocked: true,
  },
  {
    name: 'a detached flock script after the lock file and its options',
    command: "flock /tmp/lock -w 5 -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached command flock runs after the lock file and its options',
    command: "flock /tmp/lock -w 5 sh -c 'cmd 2>/dev/null' &",
    blocked: true,
  },
  {
    name: 'a detached command after an exec that discards stderr',
    command: 'exec 2>/dev/null; nohup herdr-app do space.close --confirmed &',
    blocked: true,
  },
  {
    name: 'a detached command after an exec that logs stderr',
    command: 'exec 2>/tmp/x.log; cmd &',
    blocked: false,
  },
  {
    name: 'a detached command after an exec that discards stderr inside a group',
    command: '( exec 2>/dev/null; cmd & )',
    blocked: true,
  },
  {
    name: 'a detached command after a discarded exec in another group',
    command: '( exec 2>/dev/null ); cmd &',
    blocked: false,
  },
  {
    name: 'a detached command after an exec in an enclosing brace group',
    command: 'exec 2>/dev/null; { cmd & }',
    blocked: true,
  },
  {
    name: 'a detached command after an exec a closed brace group keeps in the current shell',
    command: '{ exec 2>/dev/null; }; nohup app &',
    blocked: true,
  },
  {
    name: 'a detached command after an exec a closed paren group keeps in a subshell',
    command: '( exec 2>/dev/null; ); nohup app &',
    blocked: false,
  },
  {
    name: 'a detached command after an exec a brace group follows with a log redirection',
    command: '{ exec 2>/dev/null; } 2>/tmp/x.log; nohup app &',
    blocked: false,
  },
  {
    name: 'a detached command after an exec a brace group follows with a stdout redirection',
    command: '{ exec 2>/dev/null; } >/tmp/out; nohup app &',
    blocked: true,
  },
  {
    name: 'a detached command after an exec in an enclosing paren group',
    command: 'exec 2>/dev/null; ( cmd & )',
    blocked: true,
  },
  {
    name: 'a detached command after an exec that a group redirection overrides',
    command: 'exec 2>/dev/null; ( cmd & ) 2>/tmp/x.log',
    blocked: false,
  },
  {
    name: 'a detached command after an exec in a command substitution',
    command: 'printf "%s" "$(exec 2>/dev/null)"; nohup app &',
    blocked: false,
  },
  {
    name: 'a detached command after an exec in a heredoc body',
    command: 'cat <<EOF\n$(exec 2>/dev/null)\nEOF\nnohup app &',
    blocked: false,
  },
  {
    name: 'a detached command after an exec in a sibling substitution',
    command: 'printf "%s" "$(exec 2>/dev/null)"; printf "%s" "$(cmd &)"',
    blocked: false,
  },
  {
    name: 'a detached command in a substitution after a parent exec',
    command: 'exec 2>/dev/null; printf "%s" "$(cmd &)"',
    blocked: true,
  },
  {
    name: 'a detached command after a backgrounded exec that discards stderr',
    command: 'exec 2>/dev/null &\nnohup app &',
    blocked: false,
  },
  {
    name: 'a detached command after an env exec that discards stderr',
    command: 'env exec 2>/dev/null; cmd &',
    blocked: false,
  },
  {
    name: 'a detached command after a sudo exec that discards stderr',
    command: 'sudo exec 2>/dev/null; cmd &',
    blocked: false,
  },
  {
    name: 'a detached command after a builtin exec that discards stderr',
    command: 'builtin exec 2>/dev/null; cmd &',
    blocked: true,
  },
  {
    name: 'a detached command after a command-qualified exec that discards stderr',
    command: 'command exec 2>/dev/null; cmd &',
    blocked: true,
  },
  {
    name: 'a detached command after a command lookup of exec',
    command: 'command -v exec 2>/dev/null; cmd &',
    blocked: false,
  },
  {
    name: 'a negated compound that discards stderr',
    command: '! { cmd 2>/dev/null; } &',
    blocked: true,
  },
  {
    name: 'a timed compound that discards stderr',
    command: 'time { cmd 2>/dev/null; } &',
    blocked: true,
  },
  {
    name: 'a heredoc body command read after its owner is backgrounded',
    command: 'cat <<EOF &\n$(grep x 2>/dev/null)\nEOF',
    blocked: true,
  },
  {
    name: 'a compound whose member is named like an Object property',
    command: 'if true; then :; constructor; touch x 2>/dev/null; fi &',
    blocked: true,
  },
  {
    name: 'a foreground exec in a backgrounded brace compound',
    command: '{ exec 2>/dev/null; cmd & } &',
    blocked: true,
  },
  {
    name: 'a foreground exec before a foreground command in a backgrounded brace compound',
    command: '{ exec 2>/dev/null; cmd; } &',
    blocked: true,
  },
  {
    name: 'an exec in a pipeline element',
    command: 'exec 2>/dev/null | cat; cmd &',
    blocked: false,
  },
  {
    name: 'a redirection-only exec whose file redirection can fail',
    command: 'exec 2>/dev/null >/nope/x &',
    blocked: true,
  },
  {
    name: 'a redirection-only exec that only discards stderr',
    command: 'exec 2>/dev/null &',
    blocked: false,
  },
  {
    name: 'a redirection-only command whose file redirection can fail',
    command: '2>/dev/null >/nope/x &',
    blocked: true,
  },
  {
    name: 'a read-write redirection that discards stderr',
    command: 'cmd 2<>/dev/null &',
    blocked: true,
  },
  {
    name: 'a read-write redirection that writes a log',
    command: 'cmd 2<>/tmp/x.log &',
    blocked: false,
  },
  {
    name: 'a command the parser cannot parse',
    command: "cmd 2>/dev/null 'unterminated",
    blocked: false,
  },
  {
    name: 'a backgrounded brace compound with a redirection after its closer',
    command: '{ herdr-app do space.close --confirmed & } >/dev/null 2>&1',
    blocked: true,
  },
  {
    name: 'a backgrounded if compound with a redirection after its closer',
    command: 'if true; then herdr-app do space.close --confirmed & fi >/dev/null 2>&1',
    blocked: true,
  },
  {
    name: 'a backgrounded case inside a group that discards stderr',
    command: '( case x in a) herdr-app do space.close --confirmed ;; esac ) 2>/dev/null &',
    blocked: true,
  },
  {
    name: 'a foreground script that detaches a discarded command',
    command: "bash -c 'cmd 2>/dev/null &'",
    blocked: true,
  },
  {
    name: 'a foreground script that detaches a command under the outer discard',
    command: "bash -c 'cmd &' 2>/dev/null",
    blocked: true,
  },
  {
    name: 'a foreground script that detaches a visible command',
    command: "bash -c 'cmd &'",
    blocked: false,
  },
  {
    name: 'a foreground script that detaches a command that logs',
    command: "bash -c 'cmd > /tmp/x.log 2>&1 &'",
    blocked: false,
  },
  {
    name: 'a foreground script chain at the depth budget',
    command: nestedScript(5),
    blocked: false,
  },
  {
    name: 'a foreground script chain deeper than the depth budget',
    command: nestedScript(6),
    blocked: true,
  },
  {
    name: 'a nested script that does not parse',
    command: "bash -c 'cmd \"unterminated'",
    blocked: false,
  },
  {
    name: 'a top-level command that does not parse',
    command: "cmd 'unterminated 2>/dev/null &",
    blocked: false,
  },
])('decides $name', ({ command, blocked }) => {
  expect(blocks(command)).toBe(blocked);
});

it.each(['constructor', 'toString', '__proto__'])(
  'treats the %s command name as an ordinary command',
  (name) => {
    expect(() => decideDetachedOutput({ toolName: 'bash', command: `${name} -x &` })).not.toThrow();

    expect(blocks(`${name} -x &`)).toBe(false);
    expect(blocks(`${name} 2>/dev/null &`)).toBe(true);
  },
);

it('counts the enclosing script depth for a backgrounded script', () => {
  expect(blocks(nestedBackgroundedScript(2, 3))).toBe(true);
  expect(blocks(nestedBackgroundedScript(1, 2))).toBe(false);
});

it('reports the depth budget as unverifiable instead of claiming a detached process', () => {
  const decision = decideDetachedOutput({ toolName: 'bash', command: nestedScript(6) });

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain('nests scripts deeper than the guard can inspect');
});

it('names an env value that depends on the environment instead of the depth budget', () => {
  const decision = decideDetachedOutput({
    toolName: 'bash',
    command: `env -S "\${SHELL} -c 'make'"`,
  });

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain('depends on the environment');
  expect(decision?.reason).not.toContain('nests scripts deeper');
});

it('names a script file the guard cannot inspect', () => {
  const decision = decideDetachedOutput({ toolName: 'bash', command: 'bash script.sh &' });

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain('runs a shell script file that the guard cannot inspect');
});

it('names an unreadable nested script instead of the depth budget', () => {
  const decision = decideDetachedOutput({
    toolName: 'bash',
    command: `bash -c "env -S '\${SHELL} -c make'" &`,
  });

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain('depends on the environment');
  expect(decision?.reason).not.toContain('nests scripts deeper');
});

it('names an env value that depends on the environment on a detached command', () => {
  const decision = decideDetachedOutput({
    toolName: 'bash',
    command: `env -S "\${SHELL} -c 'cmd 2>/dev/null'" &`,
  });

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain('depends on the environment');
});

it('names an unparseable script instead of claiming a detached discard', () => {
  const decision = decideDetachedOutput({
    toolName: 'bash',
    command: `sh -c "echo 'unterminated" > /tmp/x.log 2>&1 &`,
  });

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain('cannot parse');
});

it('prefers an env value that depends on the environment over a deeper script chain', () => {
  const decision = decideDetachedOutput({
    toolName: 'bash',
    command: `${nestedScript(6)}; env -S "\${SHELL} -c 'make'"`,
  });

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain('depends on the environment');
});

it('reports a hidden failure after an unverifiable script chain', () => {
  const decision = decideDetachedOutput({
    toolName: 'bash',
    command: `${nestedScript(6)}; nohup app >/dev/null 2>&1 &`,
  });

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain('detaches a process');
});

it('ignores another tool name', () => {
  expect(decideDetachedOutput({ toolName: 'read', command: 'cmd 2>/dev/null &' })).toBeUndefined();
});

it('ignores a command that is not a string', () => {
  expect(decideDetachedOutput({ toolName: 'bash', command: undefined })).toBeUndefined();
});
