import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import type { ExtensionAPI, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import commitExtension from './commit.js';
import { writeRepositoryFile } from './fixtures/commitTool.js';
import { commitGuardReason, guardToolCall, namedFileVerdict } from './guard.js';
import type { NamedFileFacts, NamedFileVerdict } from './guard.js';

const guard = (event: ToolCallEvent, cwd = process.cwd()) => guardToolCall(event, { cwd });

// The lint rule accepts this name as an assertion, so each test keeps one call.
const expectOutcome = (event: ToolCallEvent, cwd = process.cwd()): void => {
  expect(guard(event, cwd)).toEqual({ block: true, reason: commitGuardReason });
};

const permissionsNotEnforced = process.getuid?.() === 0 || process.platform === 'win32';

const writeScript = (directory: string, name: string, text: string): string => {
  const path = join(directory, name);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);

  return path;
};

const writeScriptChain = (directory: string, levels: number): void => {
  for (let index = 0; index < levels; index += 1) {
    const isLast = index === levels - 1;
    const body = isLast ? 'git status\n' : `sh chain-${index + 1}.sh\n`;

    writeScript(directory, `chain-${index}.sh`, body);
  }
};

const writeScriptFiles = (directory: string, count: number): string[] => {
  const names: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const name = `file-${index}.sh`;

    writeScript(directory, name, 'echo hello\n');
    names.push(name);
  }

  return names;
};

const referencesTo = (names: string[]): string => names.map((name) => `sh ${name}`).join('; ');

const withEnvironment = (variable: string, value: string): void => {
  vi.stubEnv(variable, value);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
};

const withExactPath = (...entries: string[]): void => {
  withEnvironment('PATH', entries.join(delimiter));
};

const makeReadEvent = (): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'tool-call-1',
  toolName: 'read',
  input: { path: 'README.md' },
});

const makeBashEvent = (command: string): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'tool-call-1',
  toolName: 'bash',
  input: { command },
});

const nest = (levels: number) => {
  let command = 'echo hello';

  for (let level = 0; level < levels; level += 1) {
    command = `bash -c '${command.replaceAll("'", "'\\''")}'`;
  }

  return command;
};

describe('guardToolCall', () => {
  it('returns undefined for non-bash tool calls', () => {
    expect(guard(makeReadEvent())).toBeUndefined();
  });

  it.each(['git status', 'git diff HEAD', 'git log --oneline', 'git add src/foo.ts'])(
    'allows bash commands that do not run git commit: %s',
    (command) => {
      expect(guard(makeBashEvent(command))).toBeUndefined();
    },
  );

  it('allows a case pattern that names git and commit', () => {
    expect(guard(makeBashEvent('case $x in git|commit) echo ok ;; esac'))).toBeUndefined();
  });

  it('returns a block result for a plain git commit bash command', () => {
    expectOutcome(makeBashEvent("git commit -m 'feat: add'"));
  });

  it.each([
    "git commit --amend -m 'fix: typo'",
    "git add . && git commit -m 'x'",
    "echo $(git commit -m 'x')",
    "(git commit -m 'x')",
    "git-commit -m 'feat: add'",
    'echo @(#foo); git commit',
  ])('blocks commands that create commits: %s', (command) => {
    expectOutcome(makeBashEvent(command));
  });

  it.each([
    "sh -c 'git commit -m x'",
    "bash -c 'git commit -m x'",
    "sh -lc 'git commit -m x'",
    "bash -lc 'git commit -m x'",
    "bash -c   'git commit -m x'",
  ])('blocks shell commands that contain git commit: %s', (command) => {
    expectOutcome(makeBashEvent(command));
  });

  it.each(["sh -c 'git status'", "bash -c 'echo hello'"])(
    'allows shell commands without git commit: %s',
    (command) => {
      expect(guard(makeBashEvent(command))).toBeUndefined();
    },
  );

  it.each([
    'GIT_DIR=.git git commit -m x',
    "eval 'git commit -m x'",
    'command git commit -m x',
    'env git commit -m x',
    'xargs git commit -m x',
    'bash --norc -c "git commit -m x"',
    'git -C /tmp/repo commit -m x',
    'git -c user.name=x commit -m x',
  ])('blocks invocations that a command-name check misses: %s', (command) => {
    expectOutcome(makeBashEvent(command));
  });

  it('blocks a commit inside a script file the command names', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git -C . commit --allow-empty -m x\n');

    expectOutcome(makeBashEvent('sh commit.sh'), directory);
  });

  it('blocks a script file the interpreter names with a relative path', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git -C . commit --allow-empty -m x\n');

    expectOutcome(makeBashEvent('bash ./commit.sh'), directory);
  });

  it('allows a script file that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'status.sh', 'git status\n');

    expect(guard(makeBashEvent('sh status.sh'), directory)).toBeUndefined();
  });

  it('allows a script file that does not exist', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    withExactPath(pathDirectory);

    expect(guard(makeBashEvent('sh missing.sh'), directory)).toBeUndefined();
  });

  it.skipIf(permissionsNotEnforced)('blocks a script file it cannot read', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const path = writeScript(directory, 'locked.sh', 'git status\n');

    chmodSync(path, 0o000);

    expectOutcome(makeBashEvent('sh locked.sh'), directory);
  });

  it('blocks a script file that holds a NUL byte', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'binary.sh', '#!/bin/sh\ngit status\n\u0000\n');

    expectOutcome(makeBashEvent('sh binary.sh'), directory);
  });

  it('blocks a script file larger than the inspection limit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'huge.sh', 'x'.repeat(1024 * 1024 + 1));

    expectOutcome(makeBashEvent('sh huge.sh'), directory);
  });

  it('allows a shell command that reads no script file', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent('sh -s'), directory)).toBeUndefined();
  });

  it('blocks a script file given on standard input', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh < commit.sh'), directory);
  });

  it('allows an output target that holds a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'script.sh', 'echo hello\n');
    writeScript(directory, 'build.log', 'git commit -m x\n');

    expect(guard(makeBashEvent('bash script.sh > build.log'), directory)).toBeUndefined();
  });

  it('blocks a directly executed script file without a shebang', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('./commit.sh'), directory);
  });

  it.each(['#!/usr/bin/env node', '#!/usr/bin/python3'])(
    'allows a directly executed file whose shebang is not a shell: %s',
    (shebang) => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

      writeScript(directory, 'tool.js', `${shebang}\ngit commit -m x\n`);

      expect(guard(makeBashEvent('./tool.js'), directory)).toBeUndefined();
    },
  );

  it('blocks a script file an interpreter runs whatever its shebang names', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.js', '#!/usr/bin/env node\ngit commit -m x\n');

    expectOutcome(makeBashEvent('sh tool.js'), directory);
  });

  it.each([
    'bash -e commit.sh',
    'bash -o pipefail commit.sh',
    'bash --rcfile profile.sh commit.sh',
  ])('blocks a script file named after interpreter options: %s', (command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'profile.sh', 'echo hello\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it.each(['#!/bin/sh', '#!/usr/bin/env bash', '#!/usr/bin/env -S bash'])(
    'blocks a directly executed script file whose shebang is a shell: %s',
    (shebang) => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

      writeScript(directory, 'commit.sh', `${shebang}\ngit commit -m x\n`);

      expectOutcome(makeBashEvent('./commit.sh'), directory);
    },
  );

  it.each([
    ['ELF', [0x7f, 0x45, 0x4c, 0x46]],
    ['Mach-O', [0xcf, 0xfa, 0xed, 0xfe]],
    ['fat Mach-O', [0xca, 0xfe, 0xba, 0xbe]],
  ])('allows a directly executed %s binary', (_label, magic) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const bytes = Buffer.from([...magic, 0x00, 0x00, 0x00, 0x00]);

    writeFileSync(join(directory, 'a.out'), bytes);

    expect(guard(makeBashEvent('./a.out'), directory)).toBeUndefined();
  });

  it('blocks a directly executed shell script with a NUL byte in its body', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', '#!/bin/sh\ngit status\n\u0000\n');

    expectOutcome(makeBashEvent('./commit.sh'), directory);
  });

  it('allows a directly executed binary file larger than the inspection limit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const header = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]);
    const bytes = Buffer.concat([header, Buffer.alloc(1024 * 1024 + 1)]);

    writeFileSync(join(directory, 'big.bin'), bytes);

    expect(guard(makeBashEvent('./big.bin'), directory)).toBeUndefined();
  });

  it('blocks a directly executed script file larger than the inspection limit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'huge.sh', `#!/bin/sh\n${'x'.repeat(1024 * 1024)}`);

    expectOutcome(makeBashEvent('./huge.sh'), directory);
  });

  it('allows a named path that is not a regular file', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'somedir/commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh somedir'), directory)).toBeUndefined();
  });

  it('allows a script file named only as a data argument', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'scripts/commit-like.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('git add scripts/commit-like.sh'), directory)).toBeUndefined();
  });

  it('blocks a script file that names another script file holding a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'inner.sh', 'git commit -m x\n');
    writeScript(directory, 'outer.sh', 'sh inner.sh\n');

    expectOutcome(makeBashEvent('sh outer.sh'), directory);
  });

  it('allows a script file chain within the inspection budget', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScriptChain(directory, 8);

    expect(guard(makeBashEvent('sh chain-0.sh'), directory)).toBeUndefined();
  });

  it('blocks a script file chain deeper than the inspection budget', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScriptChain(directory, 9);

    expectOutcome(makeBashEvent('sh chain-0.sh'), directory);
  });

  it.each([
    'command sh commit.sh',
    'env -u FOO sh commit.sh',
    'sudo -u me bash commit.sh',
    'nohup sh commit.sh',
    'timeout 5 sh commit.sh',
    'xargs sh commit.sh',
  ])('blocks a script file after a wrapper: %s', (command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('blocks a directly executed script after a wrapper option value', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', '#!/bin/sh\ngit commit -m x\n');

    expectOutcome(makeBashEvent('env -u FOO ./commit.sh'), directory);
  });

  it('blocks a directly executed script after a wrapper duration', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', '#!/bin/sh\ngit commit -m x\n');

    expectOutcome(makeBashEvent('timeout 5 ./commit.sh'), directory);
  });

  it('blocks a script file in a directory a plain cd names', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('cd sub && sh commit.sh'), directory);
  });

  it.each([
    ['a -P option', 'cd -P sub && sh commit.sh'],
    ['a -- separator', 'cd -- sub && sh commit.sh'],
    ['an assignment prefix', 'FOO=bar cd sub && sh commit.sh'],
    ['a separate -e option', 'cd -e sub; sh commit.sh'],
    ['a clustered -e option', 'cd -eP sub; sh commit.sh'],
    ['mixed options', 'cd -P -L -e sub; sh commit.sh'],
    ['a clustered mixed option', 'cd -PLe sub; sh commit.sh'],
    ['a -P and -e pair', 'cd -P -e sub; sh commit.sh'],
    ['a -Pe cluster', 'cd -Pe sub; sh commit.sh'],
  ])('blocks a script file in a directory cd names with %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it.each([
    ['an interpreter operand', 'sh ~/commit.sh'],
    ['a direct execution', '~/commit.sh'],
  ])('blocks a script file under HOME named by %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const home = temporaryDirectory(onTestFinished, 'tau-commit-guard-home-');

    writeScript(home, 'commit.sh', '#!/bin/sh\ngit commit -m x\n');
    vi.stubEnv('HOME', home);

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    expectOutcome(makeBashEvent(command), directory);
  });

  it.each([
    ['a quoted assignment', 'env -S "FOO=\'a b\' sh commit.sh"'],
    ['a plain string', "env -S 'sh commit.sh'"],
  ])('blocks code an env -S string names with %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('uses the inherited PATH when a nested script assigns an unexpandable PATH', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const bin = temporaryDirectory(onTestFinished, 'tau-commit-guard-bin-');

    writeScript(directory, 'outer.sh', 'PATH=$BIN sh tool.sh\n');
    writeScript(bin, 'tool.sh', 'git commit -m x\n');
    withExactPath();

    expectOutcome(makeBashEvent(`PATH=${bin} sh outer.sh`), directory);
  });

  it('blocks when a PATH assignment reaches a nested script', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const bin = temporaryDirectory(onTestFinished, 'tau-commit-guard-bin-');

    writeScript(directory, 'outer.sh', 'sh tool.sh\n');
    writeScript(bin, 'tool.sh', 'git commit -m x\n');
    withExactPath();

    expectOutcome(makeBashEvent(`PATH=${bin} sh outer.sh`), directory);
  });

  it('blocks when a sourced name resolves to a committing file in PATH', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(directory, 'tool.sh', 'echo hello\n');
    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(pathDirectory);

    expectOutcome(makeBashEvent('. tool.sh'), directory);
  });

  it('allows a heredoc that mentions git commit followed by a shell name in a path', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(
      guard(
        makeBashEvent(
          "cat > notes.md <<'EOF'\nRun git commit through the tool.\nEOF\ngit add scripts/bash",
        ),
        directory,
      ),
    ).toBeUndefined();
  });

  it('blocks code piped to a dot with a device path', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expectOutcome(makeBashEvent("echo 'git commit -m x' | . /dev/stdin"), directory);
  });

  it('allows a heredoc that mentions git commit followed by git add .', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(
      guard(
        makeBashEvent("cat > notes.md <<'EOF'\nRun git commit through the tool.\nEOF\ngit add ."),
        directory,
      ),
    ).toBeUndefined();
  });

  it.each([
    ['a dot', '. commit.sh'],
    ['source', 'source commit.sh'],
  ])('blocks a script named by %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it.each([
    ['a trailing --', 'cd sub --'],
    ['a trailing option', 'cd sub -P'],
  ])('keeps the directory when cd has an operand before %s', (_label, prefix) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'sub/commit.sh', 'echo hello\n');

    expectOutcome(makeBashEvent(`${prefix}; sh commit.sh`), directory);
  });

  it.each([
    ['a busybox applet', "cat <<'EOF' | busybox sh\ngit commit -m x\nEOF"],
    ['a busybox applet with its own heredoc', "busybox sh <<'EOF'\ngit commit -m x\nEOF"],
    ['a shell after find -exec', "find . -name x -exec sh -c 'git commit -m x' \\;"],
    [
      'a shell after find -exec with a redirect',
      "find . -exec 2>/dev/null sh -c 'git commit -m x' \\;",
    ],
  ])('blocks code for %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('allows an -exec word that is data', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("echo -exec sh 'echo; git commit'"), directory)).toBeUndefined();
  });

  it('allows a find command whose exec runs no shell', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent('find . -name x -exec echo {} \\;'), directory)).toBeUndefined();
  });

  it('keeps the directory when cd names an invalid option', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const home = temporaryDirectory(onTestFinished, 'tau-commit-guard-home-');

    writeScript(directory, 'commit.sh', `git commit -m x\n`);
    writeScript(home, 'commit.sh', 'echo hello\n');
    withEnvironment('HOME', home);

    expectOutcome(makeBashEvent('cd -p; sh commit.sh'), directory);
  });

  it('keeps the directory when cd names the previous directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', `git commit -m x\n`);

    expectOutcome(makeBashEvent('cd -; sh commit.sh'), directory);
  });

  it('keeps the working directory when HOME is empty', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', `git commit -m x\n`);
    withEnvironment('HOME', '');

    expectOutcome(makeBashEvent('cd; sh commit.sh'), directory);
  });

  it('resolves a tilde operand against a relative HOME', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');
    withEnvironment('HOME', 'sub');

    expectOutcome(makeBashEvent('sh ~/commit.sh'), directory);
  });

  it.each([
    ['a separate -e option', 'cd -e sub'],
    ['a clustered mixed option', 'cd -PLe sub'],
  ])('allows a harmless script in a directory cd names with %s', (_label, prefix) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'sub/commit.sh', 'echo hello\n');

    expect(guard(makeBashEvent(`${prefix}; sh commit.sh`), directory)).toBeUndefined();
  });

  it('keeps the working directory when HOME names no directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    withEnvironment('HOME', 'missing');

    expectOutcome(makeBashEvent('cd; sh commit.sh'), directory);
  });

  it('resolves a relative HOME against the working directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');
    withEnvironment('HOME', 'sub');

    expectOutcome(makeBashEvent('cd; sh commit.sh'), directory);
  });

  it('blocks a script file in the HOME directory a bare cd names', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const home = temporaryDirectory(onTestFinished, 'tau-commit-guard-home-');

    writeScript(home, 'commit.sh', 'git commit -m x\n');
    withEnvironment('HOME', home);

    expectOutcome(makeBashEvent('cd; sh commit.sh'), directory);
  });

  it('keeps the directory when cd names more than one operand', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'a/commit.sh', 'echo hello\n');

    expectOutcome(makeBashEvent('cd a extra; sh commit.sh'), directory);
  });

  it('resolves a script named by a script in the directory it runs in', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/outer.sh', 'sh inner.sh\n');
    writeScript(directory, 'sub/inner.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('cd sub && sh outer.sh'), directory);
  });

  it('allows a command that names 64 script files', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const names = writeScriptFiles(directory, 64);

    expect(guard(makeBashEvent(referencesTo(names)), directory)).toBeUndefined();
  });

  it('blocks a command that names 65 script files', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const names = writeScriptFiles(directory, 65);

    expectOutcome(makeBashEvent(referencesTo(names)), directory);
  });

  it('allows a missing script after the read cap is reached', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
    const names = writeScriptFiles(directory, 64);

    withExactPath(pathDirectory);

    expect(
      guard(makeBashEvent(`${referencesTo(names)}; sh missing.sh`), directory),
    ).toBeUndefined();
  });

  it('does not charge a native binary to the read budget', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]);

    const names = Array.from({ length: 65 }, (_value, index) => {
      const name = `tool-${index}`;

      writeFileSync(join(directory, name), binary);

      return `./${name}`;
    });

    expect(guard(makeBashEvent(names.join('; ')), directory)).toBeUndefined();
  });

  it('reads a repeated script reference once', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const names = writeScriptFiles(directory, 64);
    const repeated = [...names, ...names.slice(0, 10)];

    expect(guard(makeBashEvent(referencesTo(repeated)), directory)).toBeUndefined();
  });

  it('allows a positional argument that names a commit file', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh -s commit.sh'), directory)).toBeUndefined();
  });

  it('blocks a script file that -s reads from standard input', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh -s < commit.sh'), directory);
  });

  it('blocks a script file read through a read-write redirection', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh <> commit.sh'), directory);
  });

  it('allows a script file read through a non-standard descriptor', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh 3< commit.sh'), directory)).toBeUndefined();
  });

  it('allows an inline shell command whose input file holds a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent("sh -c 'git status' < commit.sh"), directory)).toBeUndefined();
  });

  it('allows an inline shell command whose text names a commit file', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent("sh -c 'cat ./commit.sh'"), directory)).toBeUndefined();
  });

  it.each(["sh -c './commit.sh'", "sh -lc './commit.sh'"])(
    'blocks a directly executed script file in inline code: %s',
    (command) => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

      writeScript(directory, 'commit.sh', 'git commit -m x\n');

      expectOutcome(makeBashEvent(command), directory);
    },
  );

  it('allows an inline command that runs a script file without a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'status.sh', 'git status\n');

    expect(guard(makeBashEvent("sh -c './status.sh'"), directory)).toBeUndefined();
  });

  it('allows inline code that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent("sh -c 'git status'"), directory)).toBeUndefined();
  });

  it('blocks a script file the dot command names', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('. ./commit.sh'), directory);
  });

  it('allows a local file named like a command that resolves through PATH', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'git', 'git commit -m x\n');

    expect(guard(makeBashEvent('git status'), directory)).toBeUndefined();
  });

  it('allows a parent script from a directory whose child does not commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'x/parent.sh', 'sh child.sh\n');
    writeScript(directory, 'a/child.sh', 'git status\n');
    writeScript(directory, 'b/child.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('cd a && sh ../x/parent.sh'), directory)).toBeUndefined();
  });

  it('blocks a parent script from a second directory whose child commits', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'x/parent.sh', 'sh child.sh\n');
    writeScript(directory, 'a/child.sh', 'git status\n');
    writeScript(directory, 'b/child.sh', 'git commit -m x\n');

    expectOutcome(
      makeBashEvent('cd a && sh ../x/parent.sh; cd ../b && sh ../x/parent.sh'),
      directory,
    );
  });

  it('blocks text that starts with MZ but is not a native binary', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool', 'MZ=1\ngit commit -m x\n');

    expectOutcome(makeBashEvent('./tool'), directory);
  });

  it('blocks an outer script after a cd in a subshell', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    mkdirSync(join(directory, 'sub'), { recursive: true });

    expectOutcome(makeBashEvent('(cd sub); sh commit.sh'), directory);
  });

  it('blocks a script inside a subshell after cd', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('(cd sub && sh commit.sh)'), directory);
  });

  it('allows an interpreter name used as a data argument', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('printf sh commit.sh'), directory)).toBeUndefined();
  });

  it('blocks a script file read through a descriptor with leading zeros', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh 00< commit.sh'), directory);
  });

  it('blocks a script file duplicated onto standard input', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh 3< commit.sh <&3'), directory);
  });

  it('allows a script file input replaced by a heredoc', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh < commit.sh <<EOF\nbody\nEOF'), directory)).toBeUndefined();
  });

  it('blocks an outer script after a failed cd', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('cd missing; sh commit.sh'), directory);
  });

  it('ignores a cd inside a substitution', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'sub/commit.sh', 'git status\n');

    expectOutcome(makeBashEvent('echo $(cd sub); sh commit.sh'), directory);
  });

  it('keeps the subshell directory after a substitution cd', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'a/commit.sh', 'git commit -m x\n');
    writeScript(directory, 'b/commit.sh', 'git status\n');

    expectOutcome(makeBashEvent('( cd a; echo $(cd b); sh commit.sh )'), directory);
  });

  it('blocks a script a substitution cds into', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('echo $(cd sub && sh commit.sh)'), directory);
  });

  it.each([
    ['a heredoc substitution', 'cd sub; cat <<EOF\n$(./commit.sh)\nEOF'],
    ['a heredoc backtick', 'cd sub; cat <<EOF\n`./commit.sh`\nEOF'],
    ['a nested heredoc substitution', 'cd sub; cat <<EOF\n$(echo $(./commit.sh))\nEOF'],
  ])('blocks a script named by %s after a cd', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git status\n');
    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('blocks a heredoc on a cd command whose body runs a script from the starting directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'sub/commit.sh', 'git status\n');

    expectOutcome(makeBashEvent('cd sub <<EOF\n$(./commit.sh)\nEOF'), directory);
  });

  it('allows a heredoc on a cd command whose body runs a script only in the new directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git status\n');
    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('cd sub <<EOF\n$(./commit.sh)\nEOF'), directory)).toBeUndefined();
  });

  it('keeps a heredoc body with its owner when a later command follows it', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'sub/commit.sh', 'git status\n');

    expectOutcome(makeBashEvent('cd sub <<EOF\n$(./commit.sh)\nEOF\ntrue'), directory);
  });

  it('resolves a redirection-only heredoc after a cd in the new directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git status\n');
    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('cd sub; <<EOF\n$(./commit.sh)\nEOF'), directory);
  });

  it.each([
    ['flock lock -c', "flock lock -c 'sh commit.sh'"],
    ['flock --command', "flock --command 'sh commit.sh' lock"],
    ['flock --command=', "flock --command='sh commit.sh' lock"],
    ['flock -w 5 lock -c', "flock -w 5 lock -c 'sh commit.sh'"],
    ['flock lock -w 5 -c', "flock lock -w 5 -c 'sh commit.sh'"],
    ['flock lock -o -c', "flock lock -o -c 'sh commit.sh'"],
    ["flock -c'sh commit.sh' lock", "flock -c'sh commit.sh' lock"],
    ['flock -c repeated', "flock -c 'git status' -c 'sh commit.sh' lock"],
    ['flock --command then -c', "flock --command true -c 'sh commit.sh' lock"],
    ['flock -c repeated with a bare script', 'flock -c true -c ./commit.sh lock'],
    ['flock --command then -c with a bare script', 'flock --command true -c ./commit.sh lock'],
    ['flock lock -w 5 sh', 'flock lock -w 5 sh commit.sh'],
    ['flock lock sh -c', "flock lock sh -c 'git commit -m x'"],
    ['flock lock sh', 'flock lock sh commit.sh'],
  ])('blocks inline code after %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('allows inline code after flock that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("flock lock -c 'git status'"), directory)).toBeUndefined();
  });

  it('allows an inline-code option that belongs to the wrapped shell', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("flock lock sh -c 'git status'"), directory)).toBeUndefined();
  });

  it('reads a short option with its value attached as shell code', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expectOutcome(makeBashEvent("flock lock -c'git commit -m x'"), directory);
  });

  it('allows a trailing shell-code option with no value', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent('flock lock -c'), directory)).toBeUndefined();
  });

  it('allows a positional after shell code that flock never runs', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(
      guard(makeBashEvent("flock -c 'git status' lock ./commit.sh"), directory),
    ).toBeUndefined();
  });

  it('blocks shell code that runs a committing script file', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent("flock -c './commit.sh' lock"), directory);
  });

  it('blocks a script file fed through a duplicated stdin descriptor', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh 3< commit.sh 0>&3'), directory);
  });

  it('blocks a script file fed through a duplicated descriptor chain', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh 3< commit.sh 2>&3 <&2'), directory);
  });

  it('allows a script file fed to a non-stdin descriptor', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh 3< commit.sh 2>&3'), directory)).toBeUndefined();
  });

  it('blocks a script file named after a redirection target digit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'script.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh <2<script.sh'), directory);
  });

  it('blocks a file input after a heredoc with a descriptor', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh 3<<EOF < commit.sh\nbody\nEOF'), directory);
  });

  it('blocks a file input after a heredoc', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('sh <<EOF < commit.sh\nbody\nEOF'), directory);
  });

  it('blocks a here-string that runs a script file', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent("sh <<< './commit.sh'"), directory);
  });

  it('allows a here-string that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("sh <<< 'git status'"), directory)).toBeUndefined();
  });

  it.each(['#!/usr/bin/env FOO=bar sh', '#!/usr/bin/env -S FOO=bar sh -e'])(
    'blocks a commit in a file whose env shebang names a shell: %s',
    (shebang) => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

      writeScript(directory, 'commit.sh', `${shebang}\ngit commit -m x\n`);

      expectOutcome(makeBashEvent('./commit.sh'), directory);
    },
  );

  it.each([
    ['env -S', "env -S 'git commit -m x'"],
    ['env -S with a script', "env -S 'sh commit.sh'"],
    ['env --split-string=', "env --split-string='git commit -m x'"],
  ])('blocks inline code after %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('allows a split string that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("env -S 'git status'"), directory)).toBeUndefined();
  });

  it.each([
    ['#!/usr/bin/env -u FOO sh', '#!/usr/bin/env -u FOO sh'],
    ['#!/usr/bin/env --chdir=/ sh', '#!/usr/bin/env --chdir=/ sh'],
  ])('blocks a commit in a file with an env option: %s', (_label, shebang) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', `${shebang}\ngit commit -m x\n`);

    expectOutcome(makeBashEvent('./commit.sh'), directory);
  });

  it('allows a commit in a file whose env option names another program', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.js', '#!/usr/bin/env -u FOO node\ngit commit -m x\n');

    expect(guard(makeBashEvent('./tool.js'), directory)).toBeUndefined();
  });

  it.each([
    ['xargs -e', 'xargs -e sh commit.sh'],
    ['xargs -i', 'xargs -i sh commit.sh'],
    ['xargs -l', 'xargs -l sh commit.sh'],
    ['xargs -I', 'xargs -I {} sh commit.sh'],
  ])('blocks a script file after %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it.each([
    ['bash -c --', "bash -c -- 'git commit -m x'", undefined],
    ['bash -c -x', "bash -c -x 'git commit -m x'", undefined],
    ['bash -c -- with a script', 'bash -c -- ./commit.sh', 'commit.sh'],
    ['bash -c -x with a script', 'bash -c -x ./commit.sh', 'commit.sh'],
  ])('blocks inline code after %s', (_label, command, fixture) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    if (fixture !== undefined) {
      writeScript(directory, fixture, 'git commit -m x\n');
    }

    expectOutcome(makeBashEvent(command), directory);
  });

  it('allows inline code after bash -c that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("bash -c 'git status'"), directory)).toBeUndefined();
  });

  it.each([
    ['direct', '#!/bin/busybox'],
    ['env', '#!/usr/bin/env busybox'],
  ])('allows a commit in a file with a bare %s busybox shebang', (_label, shebang) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.js', `${shebang}\ngit commit -m x\n`);

    expect(guard(makeBashEvent('./tool.js'), directory)).toBeUndefined();
  });

  it('allows a commit in a file whose busybox applet is not a shell', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.js', '#!/usr/bin/env busybox cat\ngit commit -m x\n');

    expect(guard(makeBashEvent('./tool.js'), directory)).toBeUndefined();
  });

  it.each([
    ['fish', '#!/usr/bin/env fish'],
    ['csh', '#!/bin/csh'],
    ['busybox sh', '#!/bin/busybox sh'],
    ['env busybox sh', '#!/usr/bin/env busybox sh'],
    ['env -S busybox sh', '#!/usr/bin/env -S busybox sh'],
    ['busybox hush', '#!/bin/busybox hush'],
    ['tcsh', '#!/bin/tcsh'],
    ['yash', '#!/bin/yash'],
  ])('blocks a commit in a file with a %s shebang', (_label, shebang) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', `${shebang}\ngit commit -m x\n`);

    expectOutcome(makeBashEvent('./commit.sh'), directory);
  });

  it('blocks a commit in a file whose env -S shebang has a quoted assignment', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', "#!/usr/bin/env -S FOO='a b' sh\ngit commit -m x\n");

    expectOutcome(makeBashEvent('./commit.sh'), directory);
  });

  it('allows a commit in a file whose env shebang names another program', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.js', '#!/usr/bin/env FOO=bar node\ngit commit -m x\n');

    expect(guard(makeBashEvent('./tool.js'), directory)).toBeUndefined();
  });

  it('allows a large directly executed file whose shebang is not a shell', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.js', `#!/usr/bin/env node\n${'x'.repeat(1024 * 1024)}`);

    expect(guard(makeBashEvent('./tool.js'), directory)).toBeUndefined();
  });

  it('blocks split-string code whose trailing words run a script', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('env -S sh commit.sh'), directory);
  });

  it('keeps the argument boundary of a quoted trailing word', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(
      guard(makeBashEvent("env -S git -c 'something commit' status"), directory),
    ).toBeUndefined();
  });

  it('allows split-string code whose trailing words do not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("env -S 'git status' -x"), directory)).toBeUndefined();
  });

  it.each(['#!/usr/bin/env -Ssh -e', '#!/usr/bin/env --split-string=sh'])(
    'blocks a commit in a file with an attached split string: %s',
    (shebang) => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

      writeScript(directory, 'commit.sh', `${shebang}\ngit commit -m x\n`);

      expectOutcome(makeBashEvent('./commit.sh'), directory);
    },
  );

  it('allows a file whose attached split string names another program', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.js', '#!/usr/bin/env -Snode\ngit commit -m x\n');

    expect(guard(makeBashEvent('./tool.js'), directory)).toBeUndefined();
  });

  it('keeps the process PATH entries when an assignment cannot be expanded', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const processDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(processDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(processDirectory);

    expectOutcome(makeBashEvent('PATH=$PATH . tool.sh'), directory);
  });

  it('keeps the process PATH entries for a tilde assignment', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const processDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(processDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(processDirectory);

    expectOutcome(makeBashEvent('PATH=~/bin sh tool.sh'), directory);
  });

  it('searches the process PATH entries for an unexpanded mixed assignment', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
    const processDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(processDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(processDirectory);

    expectOutcome(makeBashEvent(`PATH=${pathDirectory}${delimiter}$PATH . tool.sh`), directory);
  });

  it('uses the last PATH assignment before the command word', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const first = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
    const second = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(second, 'tool.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(`PATH=${first} PATH=${second} sh tool.sh`), directory);
  });

  it('allows when only the first PATH assignment resolves the command', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const first = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
    const second = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(first, 'tool.sh', 'git commit -m x\n');

    expect(
      guard(makeBashEvent(`PATH=${first} PATH=${second} sh tool.sh`), directory),
    ).toBeUndefined();
  });

  it('resolves a relative PATH entry against the command directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'bin/tool.sh', 'git commit -m x\n');
    withExactPath('bin');

    expectOutcome(makeBashEvent('sh tool.sh'), directory);
  });

  it('resolves a relative PATH entry against a command directory after a cd', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/bin/tool.sh', 'git commit -m x\n');
    withExactPath('bin');

    expectOutcome(makeBashEvent('cd sub && sh tool.sh'), directory);
  });

  it.each([
    ['sh -c attached', "sh -c'git commit -m x'"],
    ['bash -lc attached', "bash -lc'./commit.sh'"],
  ])('blocks inline code attached to a short option: %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it.each([
    ['sh -onoclobber', "sh -onoclobber -c 'git commit -m x'"],
    ['bash -Ocheckwinsize', "bash -Ocheckwinsize -c 'git commit -m x'"],
    ['bash -Onocasematch', "bash -Onocasematch -c './commit.sh'"],
  ])('blocks code after a shell option that ends in c: %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('blocks attached multi-line code', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expectOutcome(makeBashEvent("bash -c'git commit -m x\necho done'"), directory);
  });

  it('blocks a script file after a disabled inline-code option', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('bash +c commit.sh'), directory);
  });

  it('blocks a script file after a disabled shell option', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('bash +s commit.sh'), directory);
  });

  it.each(['bash -onoclobber commit.sh', 'bash -Ocheckwinsize commit.sh'])(
    'blocks a script file after a shell option that ends in c: %s',
    (command) => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

      writeScript(directory, 'commit.sh', 'git commit -m x\n');

      expectOutcome(makeBashEvent(command), directory);
    },
  );

  it('allows code after a shell option that ends in c without a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("bash -onoclobber -c 'git status'"), directory)).toBeUndefined();
  });

  it.each([
    ['if then cd', 'if true; then cd sub; sh commit.sh; fi'],
    ['while do cd', 'while true; do cd sub; sh commit.sh; done'],
  ])('resolves a keyword-prefixed cd: %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('allows attached inline code that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("sh -c'git status'"), directory)).toBeUndefined();
  });

  it.each([
    ['fish', "echo 'git commit -m x' | fish"],
    ['csh', 'cat <<EOF | csh\ngit commit -m x\nEOF'],
    ['hush piped', "echo 'git commit -m x' | hush"],
    ['hush heredoc', 'cat <<EOF | hush\ngit commit -m x\nEOF'],
    ['msh piped', "echo 'git commit -m x' | msh"],
  ])('blocks piped code for %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('allows piped data for hush that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent('echo hi | hush'), directory)).toBeUndefined();
  });

  it.each([
    ['busybox sh with a script', 'busybox sh commit.sh'],
    ['busybox hush with code', "busybox hush -c 'git commit -m x'"],
  ])('blocks a busybox applet that runs code: %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('allows piped data that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent('echo hi | fish'), directory)).toBeUndefined();
  });

  it.each([
    ['if then', 'if true; then sh commit.sh; fi'],
    ['negation', '! ./commit.sh'],
    ['while do', 'while true; do sh commit.sh; done'],
  ])('blocks a script after a shell keyword: %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('allows keyword-like words that name data', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent('echo then sh commit.sh'), directory)).toBeUndefined();
  });

  it.each([
    ['sudo -Eu', 'sudo -Eu root sh commit.sh'],
    ['sudo -Euname', 'sudo -Euname sh commit.sh'],
    ['xargs -tn', 'xargs -tn 2 sh commit.sh'],
    ['sudo -C', 'sudo -C 5 sh commit.sh'],
    ['sudo --command-timeout', 'sudo --command-timeout 5 sh commit.sh'],
  ])('blocks a script after a short-option cluster: %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it('allows a cluster whose value is not the command word', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sudo -Eu sh commit.sh'), directory)).toBeUndefined();
  });

  it('blocks a script after a positional that looks like an assignment', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('flock FOO=bar sh tool.sh'), directory);
  });

  it('blocks a script resolved through env PATH=', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(`env PATH=${pathDirectory} sh tool.sh`), directory);
  });

  it('keeps a PATH assignment after another env assignment', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(`env FOO=bar PATH=${pathDirectory} sh tool.sh`), directory);
  });

  it('uses the last PATH assignment among env assignments', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const first = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
    const second = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(second, 'tool.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(`env PATH=${first} FOO=bar PATH=${second} sh tool.sh`), directory);
  });

  it.each([
    ['env -u', (directory: string) => `env -u PATH=${directory} sh tool.sh`],
    ['xargs -I', (directory: string) => `xargs -I PATH=${directory} sh tool.sh`],
  ])('ignores an option value that looks like a PATH assignment: %s', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const processDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(processDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(processDirectory);

    expectOutcome(makeBashEvent(command(join(directory, 'unused'))), directory);
  });

  // Only an assignment the shell applies to one command sets its PATH; a standalone or `export`
  // assignment is not tracked.
  it('does not apply a PATH assignment of another command to a later command', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
    const emptyDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(emptyDirectory);

    expect(
      guard(makeBashEvent(`PATH=${pathDirectory} true; sh tool.sh`), directory),
    ).toBeUndefined();
  });

  it('uses a leading PATH assignment for the probe', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(`PATH=${pathDirectory} sh tool.sh`), directory);
  });

  it('allows a bare name a leading PATH assignment does not resolve', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
    const processDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(processDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(processDirectory);

    expect(guard(makeBashEvent(`PATH=${pathDirectory} sh tool.sh`), directory)).toBeUndefined();
  });

  it('blocks a large directly executed file with no shebang', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'big.sh', `git commit -m x\n${'x'.repeat(1024 * 1024)}`);

    expectOutcome(makeBashEvent('./big.sh'), directory);
  });

  it('blocks a large file an interpreter runs', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.js', `#!/usr/bin/env node\n${'x'.repeat(1024 * 1024)}`);

    expectOutcome(makeBashEvent('sh tool.js'), directory);
  });

  it('blocks a named path that is a symlink loop', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    symlinkSync('b', join(directory, 'a'));
    symlinkSync('a', join(directory, 'b'));

    expectOutcome(makeBashEvent('sh a'), directory);
  });

  it('allows a named path whose parent is a regular file', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'dir', 'not a directory\n');

    expect(guard(makeBashEvent('sh dir/file'), directory)).toBeUndefined();
  });

  it.each([
    'setsid sh commit.sh',
    'taskset -c 0 sh commit.sh',
    'stdbuf -oL bash commit.sh',
    'flock lock sh commit.sh',
    'flock -w 5 lock sh commit.sh',
    'flock -E 3 lock sh commit.sh',
    'chrt -T 5 10 sh commit.sh',
    'flock --timeout 5 lock sh commit.sh',
    'flock --conflict-exit-code 3 lock sh commit.sh',
    'chrt --sched-runtime 5 10 sh commit.sh',
    'chrt --sched-period 5 10 sh commit.sh',
    'chrt --sched-deadline 5 10 sh commit.sh',
    'flock lock ionice -c 3 sh commit.sh',
    'flock lock taskset -c 0 sh commit.sh',
  ])('blocks a script file after another wrapper: %s', (command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent(command), directory);
  });

  it.skipIf(permissionsNotEnforced)('allows an unreadable PATH entry that finds nothing', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const locked = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    chmodSync(locked, 0o000);
    withExactPath(locked);

    try {
      expect(guard(makeBashEvent('sh tool.sh'), directory)).toBeUndefined();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(permissionsNotEnforced)(
    'blocks a PATH candidate after an unreadable PATH entry',
    () => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
      const locked = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
      const later = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

      writeScript(later, 'tool.sh', 'git commit -m x\n');
      chmodSync(locked, 0o000);
      withExactPath(locked, later);

      try {
        expectOutcome(makeBashEvent('sh tool.sh'), directory);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it.skipIf(permissionsNotEnforced)(
    'blocks a fail-closed read of a path a PATH probe found unreadable',
    () => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
      const later = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
      const script = join(later, 'tool.sh');

      writeScript(later, 'tool.sh', 'git commit -m x\n');
      chmodSync(script, 0o000);
      withExactPath(later);

      try {
        expectOutcome(makeBashEvent(`sh tool.sh; sh ${script}`), directory);
      } finally {
        chmodSync(script, 0o644);
      }
    },
  );

  it.skipIf(permissionsNotEnforced)('allows a local script before an unreadable PATH entry', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const locked = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(directory, 'tool.sh', 'git status\n');
    chmodSync(locked, 0o000);
    withExactPath(locked);

    try {
      expect(guard(makeBashEvent('sh tool.sh'), directory)).toBeUndefined();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(permissionsNotEnforced)(
    'blocks a named file whose stat fails with a permission error',
    () => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
      const locked = join(directory, 'locked');

      writeScript(directory, 'locked/commit.sh', 'git commit -m x\n');
      chmodSync(locked, 0o000);

      try {
        expectOutcome(makeBashEvent('sh locked/commit.sh'), directory);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it('inspects inline code in its own command directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent("cd sub && sh -c './commit.sh'"), directory);
  });

  it('blocks a directly executed script after an assignment word', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expectOutcome(makeBashEvent('FOO=1 ./commit.sh'), directory);
  });

  it('blocks an interpreter operand found through PATH', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(pathDirectory);

    expectOutcome(makeBashEvent('sh tool.sh'), directory);
  });

  it('allows an interpreter operand found nowhere', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    withExactPath(pathDirectory);

    expect(guard(makeBashEvent('sh tool.sh'), directory)).toBeUndefined();
  });

  it('prefers a local interpreter operand over PATH', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(directory, 'tool.sh', 'git status\n');
    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(pathDirectory);

    expect(guard(makeBashEvent('sh tool.sh'), directory)).toBeUndefined();
  });

  it('does not search PATH for an interpreter operand with a path separator', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');
    withExactPath(pathDirectory);

    expect(guard(makeBashEvent('sh ./tool.sh'), directory)).toBeUndefined();
  });

  it('allows a PATH whose directories find nothing', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    const entries = Array.from({ length: 100 }, (_value, index) =>
      join(directory, `missing-${index}`),
    );

    withExactPath(...entries);

    expect(guard(makeBashEvent('sh missing.sh'), directory)).toBeUndefined();
  });

  it('counts existing PATH candidates toward the read cap', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
    const names = Array.from({ length: 65 }, (_value, index) => `tool-${index}.sh`);

    for (const name of names) {
      writeScript(pathDirectory, name, 'echo hello\n');
    }

    withExactPath(pathDirectory);

    expectOutcome(makeBashEvent(referencesTo(names)), directory);
  });

  it('does not block pipe-to-grep patterns mentioning commit', () => {
    expect(guard(makeBashEvent('git log | grep commit'))).toBeUndefined();
  });

  it.each([
    'git diff src/extensions/commit/guard.ts',
    'git add src/skills/commit/SKILL.md',
    'git log -- src/extensions/commit',
    'git checkout src/extensions/commit/tool.ts',
    'git status src/extensions/commit/',
  ])('does not block git commands whose paths contain commit: %s', (command) => {
    expect(guard(makeBashEvent(command))).toBeUndefined();
  });

  it.each([
    'git commit-tree $tree -p HEAD -m x',
    "git update-ref HEAD $(git commit-tree $tree -p HEAD -m 'feat: x')",
  ])('blocks plumbing commands that create commits: %s', (command) => {
    expectOutcome(makeBashEvent(command));
  });

  it.each(['g\\it c\\ommit -m x', 'git co""mmit -m x', "g''it commit -m x", 'git \\commit -m x'])(
    'blocks git commit with shell escapes or empty quotes: %s',
    (command) => {
      expectOutcome(makeBashEvent(command));
    },
  );

  it('blocks a commit split across a line continuation', () => {
    expectOutcome(makeBashEvent("git \\\n  commit -m 'feat: x'"));
  });

  it.each([
    'git status; git commit -m x',
    'git status\ngit commit -m x',
    'git diff | git commit -F -',
    'false || git commit -m x',
    '(cd repo && git commit -m x)',
    '{ git commit -m x; }',
    'env GIT_AUTHOR_NAME=x git commit -m x',
    'sudo -u me /usr/bin/git commit -m x',
    '2>/dev/null git commit -m x',
    'git &>/dev/null commit -m x',
    '"git" "commit" -m x',
    'echo "$(git commit -m x)"',
    'echo `git commit -m x`',
    `echo "\${x:-$(git commit -m x)}"`,
    'cat <(git commit -m x)',
    'git $(echo commit) -m x',
    'git commit -m "$(cat <<\'EOF\'\nfeat: add\nEOF\n)"',
    'cat <<EOF\n$(git commit -m x)\nEOF',
    "bash <<'EOF'\ngit commit -m x\nEOF",
    "echo 'git commit -m x' | sh",
    'bash -c "echo \\"\\$(git commit -m x)\\""',
    "git commit -m 'unterminated",
    'git -c alias.x=commit x -m y',
    'git -c Alias.x=commit x',
    'commit_alias=commit git --config-env=alias.x=commit_alias x --allow-empty -m y',
    'v=commit git --config-env=alias.x=v x',
    'v=commit git --config-env=Alias.x=v x',
    'v=commit git --config-env alias.x=v x',
    'git $(basename /tmp/commit) --allow-empty -m x',
    'git $(echo commit-tree) $tree -m x',
    "git rebase --exec='git commit --amend --no-edit' HEAD~1",
    "git -c alias.ci='commit -m y' ci",
    "git rebase -x 'git commit --amend --no-edit' HEAD~1",
    "git submodule foreach 'git commit -m y'",
  ])('blocks commit commands the shell executes: %s', (command) => {
    expectOutcome(makeBashEvent(command));
  });

  it.each([
    'git for-each-ref --sort=-committerdate refs/heads',
    'commits="$(git log --oneline)"; echo "$commits"',
    "for c in $(git rev-list HEAD); do git show --format='### commit %H %s' $c; done",
    'for p in $(pgrep -u "$USER" -x zsh); do [ "$(readlink /proc/$p/cwd)" = "$PWD" ] && echo $p; done',
    'git log --grep=commit',
    'git log $(cat "$commits_file")',
    'git log `cat "$commits_file"`',
    'bash $(bash)',
  ])('allows git data and shell substitutions that do not commit: %s', (command) => {
    expect(guard(makeBashEvent(command))).toBeUndefined();
  });

  it.each([
    'gh pr create --title x --body "Use the commit tool, not git commit."',
    "echo 'git commit -m x'",
    'grep -rn "git commit" src',
    'git status # then git commit',
    'gh pr create --title x --body "$(cat <<\'EOF\'\nNever run git commit here.\nEOF\n)"',
    "python3 - <<'EOF'\nsource = source.replace('git commit', 'the commit tool')\nEOF",
    'cat <<EOF > notes.md\nRun git commit -m x later.\nEOF',
    'git add src/a.ts && gh pr create --title x --body "Use the commit tool, not git commit."',
  ])('allows commands that only mention git commit in data: %s', (command) => {
    expect(guard(makeBashEvent(command))).toBeUndefined();
  });

  it.each([
    '(cd x); git commit -m x',
    'a ) git commit -m x',
    '# note\ngit commit -m x',
    'echo a#b\ngit commit -m x',
    'echo a#b; git commit -m x',
    'git commit>out',
    'git commit&>/dev/null',
    'git>/dev/null commit',
    'git 2>&1 commit',
    'git\tcommit',
    'echo $(echo $((1 + 1)); git commit)',
    'echo "$(a (b) c; git commit)"',
    'bash -c "git commit -m $msg"',
    'bash -c "echo \\$(git commit)"',
    'bash -c "echo `git commit`"',
    'bash -c "a\\"; git commit"',
    'git commit <<< message',
    'git commit <<-EOF\n\tbody\n\tEOF',
    'cat <<EOF | sh\ngit commit -m x\nEOF',
    'cat <<`EOF`\n$(git commit)\n`EOF`',
    "bash -c $'git commit -m x'",
    "bash -c $'git\\x20commit -m x'",
    "git $'com\\x6dit' -m x",
    "$'g\\x69t' commit -m x",
    "echo $'\\U00110000'; git $'com\\x6dit' -m x",
    'echo "$\'$(git commit -m x)\'"',
    "cat <<EOF\n$'$(git commit -m x)'\nEOF",
    `echo "\${x:-$'$(git commit -m x)'}"`,
    'bash -c $"git commit -m x"',
    `git \${x} commit`,
    'git --config-env=alias.ab=NAME status',
    'git --config-env alias.ab=NAME status',
  ])('blocks parsed commands that run git commit: %s', (command) => {
    expectOutcome(makeBashEvent(command));
  });

  it.each([
    "echo $'git commit",
    'echo `git commit',
    "echo 'x'; git -C x commit '",
    'echo "x git commit',
    'echo $(echo "git commit" ',
    "echo <<; echo 'git commit'",
    'echo ${x git commit',
  ])('blocks unparseable input that mentions git commit: %s', (command) => {
    expectOutcome(makeBashEvent(command));
  });

  it.each(["echo $'abc", 'echo `abc', 'echo "abc', 'echo $(abc', "echo $'abc\\"])(
    'allows unparseable input without git commit: %s',
    (command) => {
      expect(guard(makeBashEvent(command))).toBeUndefined();
    },
  );

  it.each([
    'gh pr create --body "$(cat <<\'EOF\'\nDo not run `git commit` here.\nEOF\n)"',
    'gh pr create --body "$(cat <<"EOF"\nDo not run `git commit` here.\nEOF\n)"',
    'gh pr create --body "$(cat <<\\EOF\nDo not run `git commit` here.\nEOF\n)"',
    "cat <<'EOF' > notes.md\nDo not run `git commit` here.\nEOF",
    'git status\ncat <<E"O"F\n$(git commit)\nEOF',
    "cat <<$'EOF'\n$(git commit)\nEOF",
    'git log x--config-env=alias.ab=y',
    'git -c alias.commit=status status',
    'commit git status',
    'git -C x status',
    `echo \${x:-$'$(git commit)'}`,
  ])('allows data that only mentions git commit: %s', (command) => {
    expect(guard(makeBashEvent(command))).toBeUndefined();
  });

  it('allows ANSI-C quoted text without a commit', () => {
    expect(guard(makeBashEvent("echo $'a\\tb'"))).toBeUndefined();
  });

  it('blocks git commit in backticks inside an unquoted heredoc body', () => {
    const command = 'cat <<EOF\nRun `git commit` now.\nEOF';

    expectOutcome(makeBashEvent(command));
  });

  it('allows nesting up to the inspection budget and blocks deeper nesting', () => {
    expect(guard(makeBashEvent(nest(8)))).toBeUndefined();

    expectOutcome(makeBashEvent(nest(9)));
  });
});

describe('namedFileVerdict', () => {
  it.each<[NamedFileFacts, boolean, NamedFileVerdict]>([
    [{ kind: 'missing' }, true, 'allow'],
    [{ kind: 'missing' }, false, 'allow'],
    [{ kind: 'unreadable' }, true, 'block'],
    [{ kind: 'unreadable' }, false, 'block'],
    [{ kind: 'nativeBinary' }, true, 'allow'],
    [{ kind: 'nativeBinary' }, false, 'block'],
    [{ kind: 'oversize', head: '#!/usr/bin/env node\n' }, true, 'allow'],
    [{ kind: 'oversize', head: '#!/bin/sh\n' }, true, 'block'],
    [{ kind: 'oversize', head: 'git status\n' }, true, 'block'],
    [{ kind: 'oversize', head: '#!/usr/bin/env node\n' }, false, 'block'],
    [{ kind: 'text', text: '#!/usr/bin/env node\ngit commit -m x\n' }, true, 'allow'],
    [{ kind: 'text', text: '#!/usr/bin/env node\ngit commit -m x\n' }, false, 'inspect'],
    [{ kind: 'text', text: '#!/usr/bin/env node\ngit commit\u0000\n' }, true, 'allow'],
    [{ kind: 'text', text: '#!/bin/sh\ngit commit -m x\n' }, true, 'inspect'],
    [{ kind: 'text', text: 'git commit -m x\n' }, true, 'inspect'],
    [{ kind: 'text', text: 'git commit -m x\n' }, false, 'inspect'],
    [{ kind: 'text', text: '#!/bin/sh\ngit commit -m x\u0000\n' }, true, 'block'],
    [{ kind: 'text', text: '#!/bin/sh\ngit commit -m x\u0000\n' }, false, 'block'],
  ])('decides %o with checksShebang %s as %s', (facts, checksShebang, expected) => {
    expect(namedFileVerdict(facts, checksShebang)).toBe(expected);
  });
});

const createFakePi = () => {
  const getFlagMock = vi.fn<ExtensionAPI['getFlag']>().mockReturnValue(false);

  const fake = fakeExtensionApi({
    registerFlag: vi.fn<ExtensionAPI['registerFlag']>(),
    getFlag: getFlagMock,
  });

  return {
    fakePi: fake.pi,
    registeredTool: () => fake.tools.get('commit'),
    registeredHandlers: fake.handlers,
  };
};

describe('commitExtension', () => {
  it('registers the guard and tool', () => {
    const { fakePi, registeredTool, registeredHandlers } = createFakePi();

    commitExtension(fakePi);

    expect(registeredTool()).toBeDefined();
    expect(registeredHandlers.get('tool_call')).toEqual([guardToolCall]);
  });

  it('commits without registering or reading an approval flag', async () => {
    const repositoryDirectory = await createTemporaryRepository(
      onTestFinished,
      'tau-commit-guard-',
    );

    const { fakePi, registeredTool } = createFakePi();

    const custom = vi.fn<() => Promise<string>>().mockResolvedValue('abort');

    commitExtension(fakePi);

    expect(fakePi.registerFlag).not.toHaveBeenCalled();

    for (const hasUI of [true, false]) {
      const file = hasUI ? 'interactive.txt' : 'headless.txt';

      await writeRepositoryFile(repositoryDirectory, file, 'hello\n');

      const result = await registeredTool()!.execute(
        'call',
        { groups: [{ files: [file], subject: 'feat: add file' }] },
        undefined,
        undefined,
        { cwd: repositoryDirectory, hasUI, ui: { custom } } as never,
      );

      expect(result.details).toMatchObject({ groups: [{ files: [file] }] });
    }

    expect((await git(repositoryDirectory, 'rev-list', '--all', '--count')).trim()).toBe('2');
    expect(custom).not.toHaveBeenCalled();
    expect(fakePi.getFlag).not.toHaveBeenCalled();
  });

  it("does not affect the tool's own git invocations", async () => {
    const repositoryDirectory = await createTemporaryRepository(
      onTestFinished,
      'tau-commit-guard-',
    );

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    const { fakePi, registeredTool } = createFakePi();

    commitExtension(fakePi);

    const tool = registeredTool();

    if (tool == null) {
      throw new Error('Expected commit tool to be registered');
    }

    const result = await tool.execute(
      'tool-call-1',
      { groups: [{ files: ['README.md'], subject: 'feat: add thing' }] },
      undefined,
      undefined,
      {
        cwd: repositoryDirectory,
        hasUI: true,
        ui: {
          custom: () => {
            throw new Error('Unexpected approval UI');
          },
        },
      } as never,
    );

    const commitCountOutput = await git(repositoryDirectory, 'rev-list', '--all', '--count');
    const commitCount = commitCountOutput.trim();

    expect(commitCount).toBe('1');

    expect(result.details).toMatchObject({
      groups: [{ files: ['README.md'], subject: 'feat: add thing' }],
    });
  });
});
