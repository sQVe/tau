---
'tau': patch
---

Block a Git commit that a variable expansion hides from the commit guard. In code a shell is known
to run, such as `sh -c`, `eval`, a here-string, a heredoc on a shell's input, or an `env -S` value,
the guard now blocks a variable in the command name, in a Git word before the subcommand, or in the
shell's mode word. A variable in any other word stays data, including a trailing `source` operand
and text that is only a candidate script. A value attached to a Git option counts as data only when
it has no variable: the parser drops quotes, so a quoted value is blocked too, because the guard
cannot tell it from the unquoted form that can split into the subcommand. The guard still does not
read a script file whose name is a variable.
