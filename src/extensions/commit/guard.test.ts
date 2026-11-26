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

const chmodRestricted = process.getuid?.() === 0 || process.platform === 'win32';

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

const withPath = (directory: string): void => {
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
};

const withExactPath = (...entries: string[]): void => {
  vi.stubEnv('PATH', entries.join(delimiter));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
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

  it('returns a block result for a plain git commit bash command', () => {
    expect(guard(makeBashEvent("git commit -m 'feat: add'"))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each([
    "git commit --amend -m 'fix: typo'",
    "git add . && git commit -m 'x'",
    "echo $(git commit -m 'x')",
    "(git commit -m 'x')",
    "git-commit -m 'feat: add'",
    'echo @(#foo); git commit',
  ])('blocks commands that create commits: %s', (command) => {
    expect(guard(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each([
    "sh -c 'git commit -m x'",
    "bash -c 'git commit -m x'",
    "sh -lc 'git commit -m x'",
    "bash -lc 'git commit -m x'",
    "bash -c   'git commit -m x'",
  ])('blocks shell commands that contain git commit: %s', (command) => {
    expect(guard(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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
    expect(guard(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a commit inside a script file the command names', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git -C . commit --allow-empty -m x\n');

    expect(guard(makeBashEvent('sh commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a script file the interpreter names with a relative path', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git -C . commit --allow-empty -m x\n');

    expect(guard(makeBashEvent('bash ./commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('allows a script file that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'status.sh', 'git status\n');

    expect(guard(makeBashEvent('sh status.sh'), directory)).toBeUndefined();
  });

  it('allows a script file that does not exist', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent('sh missing.sh'), directory)).toBeUndefined();
  });

  it.skipIf(chmodRestricted)('blocks a script file it cannot read', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const path = writeScript(directory, 'locked.sh', 'git status\n');

    chmodSync(path, 0o000);

    expect(guard(makeBashEvent('sh locked.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a script file that holds a NUL byte', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'binary.sh', '#!/bin/sh\ngit status\n\u0000\n');

    expect(guard(makeBashEvent('sh binary.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a script file larger than the inspection limit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'huge.sh', 'x'.repeat(1024 * 1024 + 1));

    expect(guard(makeBashEvent('sh huge.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('allows a shell command that reads no script file', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent('sh -s'), directory)).toBeUndefined();
  });

  it('blocks a script file given on standard input', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh < commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent('./commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent('sh tool.js'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each([
    'bash -e commit.sh',
    'bash -o pipefail commit.sh',
    'bash --rcfile profile.sh commit.sh',
  ])('blocks a script file named after interpreter options: %s', (command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'profile.sh', 'echo hello\n');

    expect(guard(makeBashEvent(command), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each(['#!/bin/sh', '#!/usr/bin/env bash', '#!/usr/bin/env -S bash'])(
    'blocks a directly executed script file whose shebang is a shell: %s',
    (shebang) => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

      writeScript(directory, 'commit.sh', `${shebang}\ngit commit -m x\n`);

      expect(guard(makeBashEvent('./commit.sh'), directory)).toEqual({
        block: true,
        reason: commitGuardReason,
      });
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

    expect(guard(makeBashEvent('./commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent('./huge.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent('sh outer.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('allows a script file chain within the inspection budget', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScriptChain(directory, 8);

    expect(guard(makeBashEvent('sh chain-0.sh'), directory)).toBeUndefined();
  });

  it('blocks a script file chain deeper than the inspection budget', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScriptChain(directory, 9);

    expect(guard(makeBashEvent('sh chain-0.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent(command), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a directly executed script after a wrapper option value', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', '#!/bin/sh\ngit commit -m x\n');

    expect(guard(makeBashEvent('env -u FOO ./commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a directly executed script after a wrapper duration', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', '#!/bin/sh\ngit commit -m x\n');

    expect(guard(makeBashEvent('timeout 5 ./commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a script file in a directory a plain cd names', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('cd sub && sh commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('resolves a script named by a script in the directory it runs in', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/outer.sh', 'sh inner.sh\n');
    writeScript(directory, 'sub/inner.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('cd sub && sh outer.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('allows a command that names 64 script files', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const names = writeScriptFiles(directory, 64);

    expect(guard(makeBashEvent(referencesTo(names)), directory)).toBeUndefined();
  });

  it('blocks a command that names 65 script files', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const names = writeScriptFiles(directory, 65);

    expect(guard(makeBashEvent(referencesTo(names)), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent('sh -s < commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a script file read through a read-write redirection', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh <> commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

      expect(guard(makeBashEvent(command), directory)).toEqual({
        block: true,
        reason: commitGuardReason,
      });
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

    expect(guard(makeBashEvent('. ./commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(
      guard(makeBashEvent('cd a && sh ../x/parent.sh; cd ../b && sh ../x/parent.sh'), directory),
    ).toEqual({ block: true, reason: commitGuardReason });
  });

  it('blocks text that starts with MZ but is not a native binary', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool', 'MZ=1\ngit commit -m x\n');

    expect(guard(makeBashEvent('./tool'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks an outer script after a cd in a subshell', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    mkdirSync(join(directory, 'sub'), { recursive: true });

    expect(guard(makeBashEvent('(cd sub); sh commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a script inside a subshell after cd', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('(cd sub && sh commit.sh)'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('allows an interpreter name used as a data argument', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('printf sh commit.sh'), directory)).toBeUndefined();
  });

  it('blocks a script file read through a descriptor with leading zeros', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh 00< commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a script file duplicated onto standard input', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh 3< commit.sh <&3'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('allows a script file input replaced by a heredoc', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh < commit.sh <<EOF\nbody\nEOF'), directory)).toBeUndefined();
  });

  it('blocks an outer script after a failed cd', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('cd missing; sh commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('ignores a cd inside a substitution', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'sub/commit.sh', 'git status\n');

    expect(guard(makeBashEvent('echo $(cd sub); sh commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('keeps the subshell directory after a substitution cd', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'a/commit.sh', 'git commit -m x\n');
    writeScript(directory, 'b/commit.sh', 'git status\n');

    expect(guard(makeBashEvent('( cd a; echo $(cd b); sh commit.sh )'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a script a substitution cds into', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('echo $(cd sub && sh commit.sh)'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each([
    ['a heredoc substitution', 'cd sub; cat <<EOF\n$(./commit.sh)\nEOF'],
    ['a heredoc backtick', 'cd sub; cat <<EOF\n`./commit.sh`\nEOF'],
    ['a nested heredoc substitution', 'cd sub; cat <<EOF\n$(echo $(./commit.sh))\nEOF'],
  ])('blocks a script named by %s after a cd', (_label, command) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git status\n');
    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent(command), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a heredoc on a cd command whose body runs a script from the starting directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');
    writeScript(directory, 'sub/commit.sh', 'git status\n');

    expect(guard(makeBashEvent('cd sub <<EOF\n$(./commit.sh)\nEOF'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent('cd sub <<EOF\n$(./commit.sh)\nEOF\ntrue'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('resolves a redirection-only heredoc after a cd in the new directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git status\n');
    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('cd sub; <<EOF\n$(./commit.sh)\nEOF'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent(command), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('allows inline code after flock that does not create a commit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("flock lock -c 'git status'"), directory)).toBeUndefined();
  });

  it('allows an inline-code option that belongs to the wrapped shell', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent("flock lock sh -c 'git status'"), directory)).toBeUndefined();
  });

  it('reads a word starting with -c as shell code', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    expect(guard(makeBashEvent('flock lock -command'), directory)).toBeUndefined();
  });

  it('blocks a script file named after a redirection target digit', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'script.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh <2<script.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a file input after a heredoc with a descriptor', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh 3<<EOF < commit.sh\nbody\nEOF'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a file input after a heredoc', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('sh <<EOF < commit.sh\nbody\nEOF'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a here-string that runs a script file', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent("sh <<< './commit.sh'"), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

      expect(guard(makeBashEvent('./commit.sh'), directory)).toEqual({
        block: true,
        reason: commitGuardReason,
      });
    },
  );

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

  it('blocks a large directly executed file whose shebang is a shell', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'big.sh', `#!/bin/sh\n${'x'.repeat(1024 * 1024)}`);

    expect(guard(makeBashEvent('./big.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a large file an interpreter runs', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'tool.js', `#!/usr/bin/env node\n${'x'.repeat(1024 * 1024)}`);

    expect(guard(makeBashEvent('sh tool.js'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a named path that is a symlink loop', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    symlinkSync('b', join(directory, 'a'));
    symlinkSync('a', join(directory, 'b'));

    expect(guard(makeBashEvent('sh a'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent(command), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.skipIf(chmodRestricted)('allows an unreadable PATH entry that finds nothing', () => {
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

  it.skipIf(chmodRestricted)('blocks a PATH candidate after an unreadable PATH entry', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const locked = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
    const later = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(later, 'tool.sh', 'git commit -m x\n');
    chmodSync(locked, 0o000);
    withExactPath(locked, later);

    try {
      expect(guard(makeBashEvent('sh tool.sh'), directory)).toEqual({
        block: true,
        reason: commitGuardReason,
      });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(chmodRestricted)(
    'blocks a fail-closed read of a path a PATH probe found unreadable',
    () => {
      const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
      const later = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');
      const script = join(later, 'tool.sh');

      writeScript(later, 'tool.sh', 'git commit -m x\n');
      chmodSync(script, 0o000);
      withExactPath(later);

      try {
        expect(guard(makeBashEvent(`sh tool.sh; sh ${script}`), directory)).toEqual({
          block: true,
          reason: commitGuardReason,
        });
      } finally {
        chmodSync(script, 0o644);
      }
    },
  );

  it.skipIf(chmodRestricted)('allows a local script before an unreadable PATH entry', () => {
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

  it.skipIf(chmodRestricted)('blocks a named file whose stat fails with a permission error', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const locked = join(directory, 'locked');

    writeScript(directory, 'locked/commit.sh', 'git commit -m x\n');
    chmodSync(locked, 0o000);

    try {
      expect(guard(makeBashEvent('sh locked/commit.sh'), directory)).toEqual({
        block: true,
        reason: commitGuardReason,
      });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('inspects inline code in its own command directory', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'sub/commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent("cd sub && sh -c './commit.sh'"), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks a directly executed script after an assignment word', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');

    writeScript(directory, 'commit.sh', 'git commit -m x\n');

    expect(guard(makeBashEvent('FOO=1 ./commit.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('blocks an interpreter operand found through PATH', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');
    withPath(pathDirectory);

    expect(guard(makeBashEvent('sh tool.sh'), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('allows an interpreter operand found nowhere', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    withPath(pathDirectory);

    expect(guard(makeBashEvent('sh tool.sh'), directory)).toBeUndefined();
  });

  it('prefers a local interpreter operand over PATH', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(directory, 'tool.sh', 'git status\n');
    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');
    withPath(pathDirectory);

    expect(guard(makeBashEvent('sh tool.sh'), directory)).toBeUndefined();
  });

  it('does not search PATH for an interpreter operand with a path separator', () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-commit-guard-');
    const pathDirectory = temporaryDirectory(onTestFinished, 'tau-commit-guard-path-');

    writeScript(pathDirectory, 'tool.sh', 'git commit -m x\n');
    withPath(pathDirectory);

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

    expect(guard(makeBashEvent(referencesTo(names)), directory)).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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
    expect(guard(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it.each(['g\\it c\\ommit -m x', 'git co""mmit -m x', "g''it commit -m x", 'git \\commit -m x'])(
    'blocks git commit with shell escapes or empty quotes: %s',
    (command) => {
      expect(guard(makeBashEvent(command))).toEqual({
        block: true,
        reason: commitGuardReason,
      });
    },
  );

  it('blocks a commit split across a line continuation', () => {
    expect(guard(makeBashEvent("git \\\n  commit -m 'feat: x'"))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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
    expect(guard(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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
    expect(guard(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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
    expect(guard(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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

    expect(guard(makeBashEvent(command))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
  });

  it('allows nesting up to the inspection budget and blocks deeper nesting', () => {
    expect(guard(makeBashEvent(nest(8)))).toBeUndefined();

    expect(guard(makeBashEvent(nest(9)))).toEqual({
      block: true,
      reason: commitGuardReason,
    });
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
