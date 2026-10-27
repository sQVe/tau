import { describe, expect, it } from 'vitest';

import { parseShellCommands } from './shellCommands.js';

const wordsOf = (source: string) =>
  parseShellCommands(source)
    ?.map(({ words }) => words)
    .filter((words) => words.length > 0);

describe('parseShellCommands', () => {
  it.each([
    ['git commit>out', [['git', 'commit', 'out']]],
    ['git commit&>/dev/null', [['git', 'commit', '/dev/null']]],
    ['git>/dev/null commit', [['git', '/dev/null', 'commit']]],
    ['git 2>&1 commit', [['git', '2', '1', 'commit']]],
    ['git commit<in', [['git', 'commit', 'in']]],
    ['git commit>>out', [['git', 'commit', 'out']]],
    ['git commit>|out', [['git', 'commit', 'out']]],
    ['git commit<<<msg', [['git', 'commit', 'msg']]],
    ['git a&b', [['git', 'a'], ['b']]],
    ['a&&b', [['a'], ['b']]],
  ])('splits redirections from words: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual(expected);
  });

  it.each([
    ['ls # one\nstatus', [['ls'], ['status']]],
    ['# one', []],
    ['ls a#b', [['ls', 'a#b']]],
    ['ls "#x" ; echo', [['ls', '#x'], ['echo']]],
    ['ls # trailing', [['ls']]],
  ])('skips comments only at the start of a word: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual(expected);
  });

  it.each([
    [
      '(cd x); git commit',
      [
        ['cd', 'x'],
        ['git', 'commit'],
      ],
    ],
    ['a ) b', [['a'], ['b']]],
    ['echo $(a (b) c) d', [['echo', '$(a (b) c)', 'd'], ['a'], ['b'], ['c']]],
    ['echo "$(a (b) c)" d', [['echo', '$(a (b) c)', 'd'], ['a'], ['b'], ['c']]],
    ['echo $(a ((b)) c) d', [['echo', '$(a ((b)) c)', 'd'], ['a'], ['b'], ['c']]],
  ])('tracks parenthesis nesting: %s', (source, expected) => {
    const actual = wordsOf(source);

    expect(actual?.length).toBe(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    ['bash -c "git commit -m $msg"', [['bash', '-c', 'git commit -m $msg']]],
    ['echo "a$b c"', [['echo', 'a$b c']]],
    ['echo "a\\$b"', [['echo', 'a$b']]],
    ['echo "a\\`b"', [['echo', 'a`b']]],
    ['echo "a\\"b"', [['echo', 'a"b']]],
    ['echo "a\\\\b"', [['echo', 'a\\b']]],
    ['echo "a\\nb"', [['echo', 'a\\nb']]],
    ['echo "a\\\nb"', [['echo', 'ab']]],
    ['echo "a$\'x\'b"', [['echo', "a$'x'b"]]],
    ['echo "a$"b', [['echo', 'a$b']]],
  ])('reads double-quoted text: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual(expected);
  });

  it.each([
    ['echo a\\\nb', [['echo', 'ab']]],
    ['echo a\\ b', [['echo', 'a b']]],
    ['echo a\\', [['echo', 'a\\']]],
    ['echo a\\\n', [['echo', 'a']]],
    ['echo \\\nb', [['echo', 'b']]],
  ])('reads backslashes outside quotes: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual(expected);
  });

  it.each([
    [
      'echo `a \\$b`',
      [
        ['echo', '`a $b`'],
        ['a', '$b'],
      ],
    ],
    [
      'echo `a \\\\ b`',
      [
        ['echo', '`a \\ b`'],
        ['a', ' b'],
      ],
    ],
    [
      'echo `a \\nb`',
      [
        ['echo', '`a \\nb`'],
        ['a', 'nb'],
      ],
    ],
  ])('reads backticks: %s', (source, expected) => {
    const actual = wordsOf(source);

    expect(actual?.length).toBe(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    ["echo $'a b'", ['echo', 'a b']],
    ["echo $'a\\'b'", ['echo', "a'b"]],
    ["echo $'a\\\\' b", ['echo', 'a\\', 'b']],
    ['echo $"a b"', ['echo', 'a b']],
    ['echo $"a $b"', ['echo', 'a $b']],
    ['echo $"a$\'b\'"', ['echo', "a$'b'"]],
    ['echo $ b', ['echo', '$', 'b']],
    ['echo $', ['echo', '$']],
    ['echo a$', ['echo', 'a$']],
    [`echo \${a:-commit}`, ['echo', `\${a:-commit}`]],
    [`echo \${a}b`, ['echo', `\${a}b`]],
    [`echo \${a:-$'\\x41'}`, ['echo', `\${a:-A}`]],
    [`echo "\${a:-$'b'}"`, ['echo', `\${a:-$'b'}`]],
    ['echo $(a)b', ['echo', '$(a)b']],
  ])('reads dollar forms: %s', (source, expected) => {
    expect(wordsOf(source)?.[0]).toEqual(expected);
  });

  it.each([
    ["$'com\\x6dit'", 'commit'],
    ["$'\\x6'", '\u0006'],
    ["$'\\x'", '\\x'],
    ["$'com\\x{6d}it'", 'commit'],
    ["$'com\\x{06Dit'", 'commit'],
    ["$'com\\x{2000000000006d}it'", 'commit'],
    ["$'com\\155it'", 'commit'],
    ["$'\\0'", ''],
    ["$'\\1555'", 'm5'],
    ["$'com\\u006dit'", 'commit'],
    ["$'\\U0001F600'", '\u{1F600}'],
    ["$'\\U0010FFFF'", '\u{10FFFF}'],
    ["g$'\\U00110000'it", 'g\uFFFDit'],
    ["$'\\cA\\c?'", '\u0001\u007F'],
    ["$'\\ca\\c1\\c\\\\x'", '\u0001\u0011\u001Cx'],
    ["$'\\c'", '\\c'],
    ["$'com\\0x'mit", 'commit'],
    ["$'com\\x{}x'mit", 'commit'],
    ["$'\\u'", '\\u'],
    ["$'\\a\\b\\e\\E\\f\\n\\r\\t\\v'", '\u0007\b\u001B\u001B\f\n\r\t\v'],
    ["$'\\\\\\'\\\"\\?'", '\\\'"?'],
    ["$'\\q'", '\\q'],
  ])('decodes ANSI-C escapes: %s', (source, expected) => {
    expect(wordsOf(source)).toEqual([[expected]]);
  });

  it.each([
    "echo $'abc",
    "echo $'abc\\",
    'echo `abc',
    'echo `abc\\',
    'echo ${abc',
    'echo $(abc',
    "echo 'abc",
    'echo "abc',
    'echo "abc\\',
  ])('rejects unterminated input: %s', (source) => {
    expect(parseShellCommands(source)).toBeUndefined();
  });

  it.each(['cat <<;', 'cat <<-;', 'cat << )'])(
    'rejects a heredoc without a delimiter: %s',
    (source) => {
      expect(parseShellCommands(source)).toBeUndefined();
    },
  );

  it('reads a heredoc body after the line ends', () => {
    expect(parseShellCommands('cat <<EOF\nbody\nEOF\nnext')).toEqual([
      { words: ['cat'], heredocs: ['body\n'] },
      { words: ['next'], heredocs: [] },
    ]);
  });

  it('strips leading tabs from the delimiter line only for <<-', () => {
    expect(parseShellCommands('cat <<-EOF\n\tbody\n\tEOF\nnext')?.[0]?.heredocs).toEqual([
      '\tbody\n',
    ]);

    expect(parseShellCommands('cat <<EOF\n\tEOF\nEOF\nnext')?.[0]?.heredocs).toEqual(['\tEOF\n']);
  });

  it('does not treat <<< as a heredoc', () => {
    expect(parseShellCommands('cat <<< word\nnext')).toEqual([
      { words: ['cat', 'word'], heredocs: [] },
      { words: ['next'], heredocs: [] },
    ]);
  });

  it.each(["<<'EOF'", '<<"EOF"', '<<\\EOF', '<<E"O"F', "<<$'EOF'", '<<$"EOF"', '<<E\\OF'])(
    'does not parse the body of a heredoc with a quoted delimiter: %s',
    (operator) => {
      const commands = parseShellCommands(`cat ${operator}\n$(git commit)\nEOF\n`);

      expect(commands?.flatMap(({ words }) => words)).toEqual(['cat']);
    },
  );

  it('parses the body of a heredoc with an unquoted delimiter', () => {
    const commands = parseShellCommands('cat <<EOF\n$(git commit)\nEOF\n');

    expect(commands?.map(({ words }) => words)).toContainEqual(['git', 'commit']);
  });

  it('parses the body of a heredoc after a quoted word of another command', () => {
    const commands = parseShellCommands("echo 'x'\ncat <<EOF\n$(git commit)\nEOF\n");

    expect(commands?.map(({ words }) => words)).toContainEqual(['git', 'commit']);
  });

  it('splits words at tabs', () => {
    expect(wordsOf('git\tcommit')).toEqual([['git', 'commit']]);
  });

  it('keeps command substitution text in one word across separators', () => {
    const actual = wordsOf('echo $(a; b | c & d\ne) f');

    expect(actual?.[0]).toEqual(['echo', '$(a; b | c & d\ne)', 'f']);
    expect(actual).toContainEqual(['e']);
  });

  it('lists commands from backticks inside double quotes', () => {
    const actual = wordsOf('echo "a `git commit`"');

    expect(actual).toEqual([
      ['echo', 'a `git commit`'],
      ['git', 'commit'],
    ]);
  });

  it('reads the body of a heredoc that starts the source', () => {
    const commands = parseShellCommands('<<EOF cat\n$(git commit)\nEOF\n');

    expect(commands?.map(({ words }) => words)).toContainEqual(['git', 'commit']);
  });

  it('reads an empty heredoc when the source ends after the operator', () => {
    expect(parseShellCommands('cat <<EOF')).toEqual([{ words: ['cat'], heredocs: [''] }]);
  });

  it('keeps the heredoc body free of a phantom line at the end of the source', () => {
    expect(parseShellCommands('cat <<EOF\nbody\n')?.[0]?.heredocs).toEqual(['body\n']);
  });

  it('strips every leading tab, and only leading tabs, before comparing the delimiter', () => {
    expect(parseShellCommands('cat <<-ab\na\tb\nab\nnext')?.[0]?.heredocs).toEqual(['a\tb\n']);

    const commands = parseShellCommands('cat <<-EOF\n\t\tEOF\nnext');

    expect(commands?.[0]?.heredocs).toEqual(['']);
    expect(commands?.map(({ words }) => words)).toContainEqual(['next']);
  });

  it.each(['`EOF`', '$(echo EOF)', `\${E}`, '$'])(
    'parses the body of a heredoc whose delimiter is %s',
    (delimiter) => {
      const commands = parseShellCommands(`cat <<${delimiter}\n$(git commit)\n${delimiter}\n`);

      expect(commands?.map(({ words }) => words)).toContainEqual(['git', 'commit']);
    },
  );
});
