---
'tau': patch
---

Block only `git commit` commands the shell would run. Text in quoted arguments, comments, and
heredoc bodies no longer triggers the bash commit guard, so `gh pr create --body` text and scripts
that mention `git commit` pass. Chains, pipelines, subshells, substitutions, command prefixes, and
text passed to a shell such as `sh -c` or `| bash` still block. Commands that do not parse fall back
to the previous stricter match.
