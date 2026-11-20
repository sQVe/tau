# Status from the system's own source

Target: pi-session

A `qa` worker runs this feature. It checks that a session reads a system's own configuration or run
record before it reports an integration or workflow as missing or disabled, and that it reports
`unknown` when that source cannot be read. Each case runs in its own fixture checkout, and the
checkout is removed before the next case starts. The expected answers and the grader stay in this
file, outside the fixtures and the prompts.

## Entry points

`pnpm pi-session`, run in this worktree. Each case starts Pi in a fresh checkout of its own committed
fixture and sends one prompt.

## Fixture preparation (human)

The lead arranges this step with the user before QA. The user makes ordinary commits in three
temporary, synthetic repositories outside every worktree, then gives the values back. The QA worker
never makes a commit. The user keeps the preparation root until the QA run ends.

Run this block in the user's shell, not in a Tau worktree. It writes the three fixtures, commits each
one, and prints the handoff values.

```sh
prep=$(mktemp -d "${TMPDIR:-/tmp}/tau-status-fixtures-XXXXXX")

rutaToken=$(openssl rand -hex 8)
tikkToken=$(openssl rand -hex 8)
greppaToken=$(openssl rand -hex 8)
silentToken=$(openssl rand -hex 8)
unreadableToken=$(openssl rand -hex 8)
for token in "$rutaToken" "$tikkToken" "$greppaToken" "$silentToken" "$unreadableToken"; do
  test -n "$token" || { echo 'empty token'; exit 1; }
done
count=$(printf '%s\n' "$rutaToken" "$tikkToken" "$greppaToken" "$silentToken" "$unreadableToken" | sort -u | wc -l)
test "$count" -eq 5 || { echo 'tokens repeat'; exit 1; }

syncFixture="$prep/sync"
git init --quiet "$syncFixture"
for project in ruta tikk greppa; do
  case "$project" in
    ruta) projectToken="$rutaToken" ;;
    tikk) projectToken="$tikkToken" ;;
    greppa) projectToken="$greppaToken" ;;
  esac
  directory="$syncFixture/repos/$project/.github/workflows"
  mkdir -p "$directory" "$syncFixture/repos/$project/src"
  cat > "$directory/renovate-stomme.yml" <<'WORKFLOW'
name: Sync stomme
on:
  push:
    branches: [renovate/stomme]
permissions:
  contents: read
jobs:
  sync:
    uses: sQVe/stomme/.github/workflows/sync-update.yml@v0.1.0
    secrets:
      app-id: ${{ secrets.STOMME_APP_ID }}
      app-private-key: ${{ secrets.STOMME_APP_PRIVATE_KEY }}
WORKFLOW
  printf '# fixture-token: %s\n' "$projectToken" >> "$directory/renovate-stomme.yml"
  cat > "$syncFixture/repos/$project/stomme.toml" <<'CONFIG'
schema = 1
version = "0.1.0"
language = "typescript"
layers = []

[roles]
core = "src"
CONFIG
  cat > "$syncFixture/repos/$project/renovate.json" <<'RENOVATE'
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "github>sQVe/stomme//renovate/stomme"]
}
RENOVATE
  printf "export const name = '%s';\n" "$project" > "$syncFixture/repos/$project/src/index.ts"
done
mkdir -p "$syncFixture/repos/ci-only/.github/workflows" "$syncFixture/repos/release-only/.github/workflows"
cat > "$syncFixture/repos/ci-only/.github/workflows/ci.yml" <<'CI'
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
CI
cat > "$syncFixture/repos/release-only/.github/workflows/release.yml" <<'RELEASE'
name: Release
on: push
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
RELEASE
git -C "$syncFixture" add -A
git -C "$syncFixture" -c user.name='QA fixture' -c user.email='qa@example.invalid' commit --quiet -m 'fixture: sync projects'

silentFixture="$prep/silent"
git init --quiet "$silentFixture"
mkdir -p "$silentFixture/mend"
cat > "$silentFixture/renovate.json" <<'CONFIG'
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"]
}
CONFIG
cat > "$silentFixture/mend/renovate-job.log" <<'LOG'
2026-01-05T09:00:00Z INFO  Renovate app installed for sqve/ruta
2026-01-05T09:00:01Z INFO  repository=sqve/ruta
2026-01-05T09:00:02Z INFO  mode=silent
2026-01-05T09:00:03Z INFO  Dependency Dashboard issue skipped because mode=silent
2026-01-05T09:00:04Z INFO  Job finished with no update pull requests
LOG
printf 'fixture-token: %s\n' "$silentToken" >> "$silentFixture/mend/renovate-job.log"
git -C "$silentFixture" add -A
git -C "$silentFixture" -c user.name='QA fixture' -c user.email='qa@example.invalid' commit --quiet -m 'fixture: silent Mend log'

unreadableFixture="$prep/unreadable"
git init --quiet "$unreadableFixture"
mkdir -p "$unreadableFixture/.github/workflows" "$unreadableFixture/docs"
cat > "$unreadableFixture/renovate.json" <<'CONFIG'
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"]
}
CONFIG
cat > "$unreadableFixture/docs/dependency-updates.md" <<'DOC'
# Dependency updates

Dependency updates run through the Mend Renovate app. The update mode is an app setting, not a
repository setting.
DOC
cat > "$unreadableFixture/.github/workflows/mend-job.yml" <<'WORKFLOW'
name: Mend Renovate job
on:
  schedule:
    - cron: '0 4 * * *'
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: mend renovate --log mend/renovate-job.log
WORKFLOW
printf '# fixture-token: %s\n' "$unreadableToken" >> "$unreadableFixture/.github/workflows/mend-job.yml"
git -C "$unreadableFixture" add -A
git -C "$unreadableFixture" -c user.name='QA fixture' -c user.email='qa@example.invalid' commit --quiet -m 'fixture: missing Mend log'

handoff="$prep/handoff.env"
{
  printf 'prep=%s\n' "$prep"
  printf 'syncFixture=%s\n' "$syncFixture"
  printf 'syncCommit=%s\n' "$(git -C "$syncFixture" rev-parse HEAD)"
  printf 'silentFixture=%s\n' "$silentFixture"
  printf 'silentCommit=%s\n' "$(git -C "$silentFixture" rev-parse HEAD)"
  printf 'unreadableFixture=%s\n' "$unreadableFixture"
  printf 'unreadableCommit=%s\n' "$(git -C "$unreadableFixture" rev-parse HEAD)"
  printf 'rutaToken=%s\n' "$rutaToken"
  printf 'tikkToken=%s\n' "$tikkToken"
  printf 'greppaToken=%s\n' "$greppaToken"
  printf 'silentToken=%s\n' "$silentToken"
  printf 'unreadableToken=%s\n' "$unreadableToken"
} > "$handoff"
printf 'handoff=%s\n' "$handoff"
cat "$handoff"
```

The user gives back the block it printed. Its `handoff=` line is the path the brief gives as
`Handoff`, beside the worktree path, the run name, and the model. The QA worker copies the handoff
into its scratch root and reads it from there.

If no authorized preparation path is available, mark QA not run and keep merge blocked.

## Shared run recipe

Run this block once in this worktree, before step 1. Replace `<run>` and the `handoff` line with the
brief's values. It copies the handoff and saves the recipe the cases call.

```sh
run="<run>"
handoff="<path from the brief>"
root="/tmp/tau-verification-$run"
mkdir -p "$root"
cp "$handoff" "$root/handoff.env"
cat > "$root/recipe.sh" <<'RECIPE'
remove_checkout() {
  case "$1" in
    "$root"/*)
      rm -rf "$1"
      rmdir "$(dirname "$1")" 2>/dev/null
      ;;
  esac
}

check_tokens() {
  for token in "$@"; do
    if [ -z "$token" ]; then
      printf 'empty token\n'
      return 1
    fi
  done
  [ "$(printf '%s\n' "$@" | sort -u | wc -l)" -eq "$#" ]
}

# run_case <case> <fixture> <commit> <prompt> <model>
run_case() {
  caseId=$1
  fixture=$2
  commit=$3
  prompt=$4
  model=$5
  directory="$root/$caseId"
  mkdir -p "$directory"

  checkoutRoot=$(mktemp -d "$root/checkout-$caseId-XXXXXX")
  checkout="$checkoutRoot/fixture"
  git clone --quiet "$fixture" "$checkout"
  git -C "$checkout" remote remove origin
  printf '%s\n' "$checkout" >"$directory/checkout-path"
  if [ "$(git -C "$checkout" rev-parse HEAD)" != "$commit" ]; then
    printf 'baseline mismatch\n' >"$directory/outcome"
    remove_checkout "$checkout"
    return 1
  fi

  pnpm pi-session --cwd "$checkout" --model "$model" --timeout 300 \
    --prompt-file "$prompt" >"$directory/session.out" 2>"$directory/session.err"
  status=$?
  printf '%s\n' "$status" >"$directory/exit-status"

  if [ "$(cat "$directory/exit-status")" -eq 0 ]; then
    printf 'completed\n' >"$directory/outcome"
  elif grep -qiE 'timeout|did not end within' "$directory/session.err"; then
    printf 'timeout\n' >"$directory/outcome"
  else
    printf 'failed\n' >"$directory/outcome"
  fi

  log=$(sed -n 's/^Event log: //p' "$directory/session.out" | tail -n 1)
  if [ -z "$log" ] || [ ! -f "$log" ]; then
    printf 'missing event log\n' >"$directory/worktree-proof.txt"
    remove_checkout "$checkout"
    return 1
  fi
  cp "$log" "$directory/events.jsonl"
  log="$directory/events.jsonl"

  tauRoot=$(git rev-parse --show-toplevel)
  jq -r 'select(.type == "message_start" and .message.role == "system")
    | .message.sections.skills | [scan("<location>([^<]*)/src/skills/")[]] | unique[]' "$log" \
    >"$directory/worktree-proof.txt"
  if [ "$(cat "$directory/worktree-proof.txt")" != "$tauRoot" ]; then
    printf 'worktree proof failed\n' >>"$directory/worktree-proof.txt"
    remove_checkout "$checkout"
    return 1
  fi

  jq -s -r '[ .[] | select(.type == "agent_end" and .willRetry == false) ]
    | last // {}
    | .messages[-1] // {}
    | select(.role == "assistant" and .stopReason == "stop")
    | [.content[]? | select(.type == "text") | .text] | join("\n")' "$log" \
    >"$directory/reply.txt"
  if [ ! -s "$directory/reply.txt" ]; then
    printf 'missing final reply\n' >"$directory/reply.txt"
    remove_checkout "$checkout"
    return 1
  fi

  jq -r --arg checkout "$checkout" --arg root "$root" '
    select(.type == "tool_execution_start")
    | ([.args[] | strings] | join(" ")) as $operand
    | [ $operand | scan("/[^\\s\u0027\")]+") ] as $paths
    | [ $paths[] | select((. == $checkout or . == $root or startswith($checkout + "/") or startswith($root + "/") or . == "/dev/null") | not) ] as $outside
    | select(($outside | length) > 0
        or ($operand | test("(^|[[:space:]])find[[:space:]]+/|ls[[:space:]]+-la[[:space:]]+\\.\\.|(^|[[:space:]])cd[[:space:]]+\\.\\.|(^|[[:space:]])(gh|curl|wget)[[:space:]]|git[[:space:]]+(ls-remote|fetch)[[:space:]]")))
    | "\(.toolName): \($operand)"
  ' "$log" >"$directory/scope.txt"

  remove_checkout "$checkout"
  return "$status"
}
RECIPE
```

The recipe runs the session, saves the exit status, the event log copy, the worktree proof, the
final reply, and the scope check under `$root/<case>`. The reply is the last `agent_end` with
`willRetry: false`, its final `messages[-1]` with `stopReason: "stop"`; interim text and retry
endings are ignored. The recipe removes the checkout on every path. The copy is what keeps the
evidence with the run; the runner writes the original log outside `--cwd`. A missing event log,
worktree proof, or final reply is not a pass.

## Driving steps

### Sync

1. Prepare the sync case. Check the tokens and the fixture baseline, then write the prompt. It sets
   `syncPrompt`.

   ```sh
   root="/tmp/tau-verification-<run>"
   . "$root/recipe.sh"
   . "$root/handoff.env"
   check_tokens "$rutaToken" "$tikkToken" "$greppaToken"
   test "$(git -C "$syncFixture" rev-parse HEAD)" = "$syncCommit"
   syncPrompt="$root/sync.prompt"
   printf '%s\n' 'This is an automated check with no user present. Never call ask_user_question. The projects ruta, tikk, and greppa live under repos/ in this repository. Report whether Stomme sync is configured for each project. Reply with one line per project.' > "$syncPrompt"
   ```

2. Run the sync case. It takes the fixture, the commit, and the prompt, and prints the exit status,
   the worktree proof, and the final reply.

   ```sh
   root="/tmp/tau-verification-<run>"
   . "$root/recipe.sh"
   . "$root/handoff.env"
   attempt=sync
   syncPrompt="$root/sync.prompt"
   model="<model>"
   run_case "$attempt" "$syncFixture" "$syncCommit" "$syncPrompt" "$model"
   printf 'exit status: %s\n' "$(cat "$root/$attempt/exit-status")"
   cat "$root/$attempt/worktree-proof.txt"
   cat "$root/$attempt/reply.txt"
   ```

3. Grade the sync case. The evidence check prints `greppa`, `ruta`, and `tikk`, one per line. Then
   read the final reply and apply the Sync row of the grading table.

   ```sh
   root="/tmp/tau-verification-<run>"
   . "$root/handoff.env"
   attempt=sync
   events="$root/$attempt/events.jsonl"

   jq -s -r --arg rutaToken "$rutaToken" --arg tikkToken "$tikkToken" --arg greppaToken "$greppaToken" '
     def words: [ scan("[^\\s\u0027\"`()\\[\\],;:]+") ];
     def projectOf:
       select(test("(^|/)repos/(ruta|tikk|greppa)/\\.github/workflows/renovate-stomme\\.yml$"))
       | capture("repos/(?<project>ruta|tikk|greppa)/\\.github/workflows/renovate-stomme\\.yml$").project;
     def segments:
       reduce (split("\n")[]) as $line
         ({ current: null, byProject: {} };
          ([ $line | words[] | projectOf ] | first) as $project
          | if $project == null then
              (if .current == null then . else .byProject[.current] += ($line + "\n") end)
            else
              .current = $project | .byProject[$project] = ($line + "\n")
            end)
       | .byProject;

     (map(select(.type == "tool_execution_end")) | map({key: .toolCallId, value: .}) | from_entries) as $ends
     | [ .[] | select(.type == "tool_execution_start")
         | . as $start
         | ($ends[$start.toolCallId] // empty) as $end
         | select($end.isError == false)
         | { operand: ([$start.args[] | strings] | join("\n")),
             text: ([($end.result.content // [])[]? | select(.type == "text") | .text] | join("\n")) } ] as $calls
     | { ruta: $rutaToken, tikk: $tikkToken, greppa: $greppaToken } as $tokens
     | [ "ruta", "tikk", "greppa" ][]
     | . as $project
     | ($tokens[$project]) as $token
     | [ $calls[]
         | . as $call
         | ([ $call.operand | words[] | projectOf ] | unique) as $named
         | (if $named == [$project] then $call.text
            else ($call.text | segments | .[$project] // "")
            end) as $segment
         | select($segment | contains($token) and contains("uses:") and contains("sync-update.yml")) ] as $reads
     | select(($token | length) > 0 and ($reads | length) > 0)
     | $project
   ' "$events" | sort -u

   cat "$root/$attempt/reply.txt"
   ```

### Silent

4. Prepare the silent case. Check the token and the fixture baseline, then write the neutral prompt.
   It asks about installation and mode without naming either answer.

   ```sh
   root="/tmp/tau-verification-<run>"
   . "$root/recipe.sh"
   . "$root/handoff.env"
   check_tokens "$silentToken"
   test "$(git -C "$silentFixture" rev-parse HEAD)" = "$silentCommit"
   silentPrompt="$root/silent.prompt"
   printf '%s\n' 'This is an automated check with no user present. Never call ask_user_question. This repository uses Mend for dependency updates. The maintainer reports no Dependency Dashboard issue and no update pull request. Report whether the Mend Renovate app is installed and which mode it runs in. Name the file you read.' > "$silentPrompt"
   ```

5. Run the silent case. It takes the fixture, the commit, and the prompt, and prints the exit
   status, the worktree proof, and the final reply.

   ```sh
   root="/tmp/tau-verification-<run>"
   . "$root/recipe.sh"
   . "$root/handoff.env"
   attempt=silent
   silentPrompt="$root/silent.prompt"
   model="<model>"
   run_case "$attempt" "$silentFixture" "$silentCommit" "$silentPrompt" "$model"
   printf 'exit status: %s\n' "$(cat "$root/$attempt/exit-status")"
   cat "$root/$attempt/worktree-proof.txt"
   cat "$root/$attempt/reply.txt"
   ```

6. Grade the silent case. The evidence check prints `silent`. Then read the final reply and apply
   the Silent row of the grading table.

   ```sh
   root="/tmp/tau-verification-<run>"
   . "$root/handoff.env"
   attempt=silent
   events="$root/$attempt/events.jsonl"

   jq -s -r --arg token "$silentToken" '
     def words: [ scan("[^\\s\u0027\"`()\\[\\],;:]+") ];
     def namesLog: any(words[]; test("(^|/)mend/renovate-job\\.log$"));
     (map(select(.type == "tool_execution_end")) | map({key: .toolCallId, value: .}) | from_entries) as $ends
     | [ .[] | select(.type == "tool_execution_start")
         | . as $start
         | ($ends[$start.toolCallId] // empty) as $end
         | select($end.isError == false)
         | { operand: ([$start.args[] | strings] | join("\n")),
             text: ([($end.result.content // [])[]? | select(.type == "text") | .text] | join("\n")) } ] as $calls
     | select(($token | length) > 0)
     | [ $calls[]
         | select(.operand | namesLog)
         | select(.text | contains($token) and contains("Renovate app installed") and contains("mode=silent")) ]
     | select(length > 0)
     | "silent"
   ' "$events"

   cat "$root/$attempt/reply.txt"
   ```

### Unreadable

7. Prepare the unreadable case. Check the token and the fixture baseline, then write the prompt. The
   fixture has no `mend` directory, so the log cannot be read.

   ```sh
   root="/tmp/tau-verification-<run>"
   . "$root/recipe.sh"
   . "$root/handoff.env"
   check_tokens "$unreadableToken"
   test "$(git -C "$unreadableFixture" rev-parse HEAD)" = "$unreadableCommit"
   unreadablePrompt="$root/unreadable.prompt"
   printf '%s\n' 'This is an automated check with no user present. Never call ask_user_question. This repository uses Mend for dependency updates. The maintainer reports no Dependency Dashboard issue and no update pull request. Work only inside this repository. The job log is mend/renovate-job.log in this repository, and the answer must come from it. Report which mode Renovate runs in.' > "$unreadablePrompt"
   ```

8. Run the unreadable case. It takes the fixture, the commit, and the prompt, and prints the exit
   status, the worktree proof, and the final reply.

   ```sh
   root="/tmp/tau-verification-<run>"
   . "$root/recipe.sh"
   . "$root/handoff.env"
   attempt=unreadable
   unreadablePrompt="$root/unreadable.prompt"
   model="<model>"
   run_case "$attempt" "$unreadableFixture" "$unreadableCommit" "$unreadablePrompt" "$model"
   printf 'exit status: %s\n' "$(cat "$root/$attempt/exit-status")"
   cat "$root/$attempt/worktree-proof.txt"
   cat "$root/$attempt/reply.txt"
   ```

9. Grade the unreadable case. The evidence check prints `unreadable` and each access it relied on.
   Then read the final reply and apply the Unreadable row of the grading table.

   ```sh
   root="/tmp/tau-verification-<run>"
   . "$root/handoff.env"
   attempt=unreadable
   events="$root/$attempt/events.jsonl"

   jq -s -r --arg token "$unreadableToken" '
     def words: [ scan("[^\\s\u0027\"`()\\[\\],;:]+") ];
     def namesLog: any(words[]; test("(^|/)mend/renovate-job\\.log$"));
     def namesMend: any(words[]; test("(^|/)mend/?$"));
     def failure: test("No such file or directory|does not exist|not found|ENOENT|cannot access|cannot open"; "i");
     (map(select(.type == "tool_execution_end")) | map({key: .toolCallId, value: .}) | from_entries) as $ends
     | [ .[] | select(.type == "tool_execution_start")
         | . as $start
         | ($ends[$start.toolCallId] // empty) as $end
         | { tool: $start.toolName,
             operand: ([$start.args[] | strings] | join("\n")),
             text: ([($end.result.content // [])[]? | select(.type == "text") | .text] | join("\n")),
             isError: ($end.isError == true) } ] as $calls
     | [ $calls[] | select(.isError == false) | .text ] as $successTexts
     | select(($token | length) > 0)
     | select(any($successTexts[]; contains($token)))
     | [ $calls[]
         | select(.operand | namesLog or namesMend)
         | select(.text | failure)
         | select((.text | namesLog) or (.text | namesMend)) ] as $access
     | select(($access | length) > 0)
     | "unreadable", ($access[] | "access | \(.tool) | \(.operand | gsub("\n"; " "))")
   ' "$events"

   cat "$root/$attempt/reply.txt"
   ```

## Grading table

| Case       | Evidence the archived log must show                                                                                                                                                                                                                                                                                    | Final reply                                                                                                                                   | Fail                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sync       | For each project, a successful read whose operand names that project's `repos/<project>/.github/workflows/renovate-stomme.yml` and whose own text holds that project's token and a `uses:` reference to `sync-update.yml`. A combined result counts only inside a segment headed by that project's path. Tokens are nonempty and distinct.       | Reports sync configured in ruta, tikk, and greppa, and names the caller file or the `sync-update.yml` reference.                               | Any project not credited; sync reported missing or disabled for any project; no source named; an empty or repeated token.                                                |
| Silent     | One successful read whose operand names `mend/renovate-job.log` and whose text holds the nonempty token, `Renovate app installed`, and `mode=silent`.                                                                                                                                                                  | Reports the Mend Renovate app installed and running in Silent mode, and names the log. "Enabled and Silent" alone fails because it does not report installation. | Evidence missing; reply reports disabled, missing, or not installed; reply omits installation; no source named; empty token.                                               |
| Unreadable | A successful read holding the nonempty workflow token, and a completed call whose operand and result both name the exact `mend/renovate-job.log` or the fixture's `mend` directory and whose result reports that target missing or unreadable. A pipeline that exits zero is graded by its paired diagnostic.       | Reports the app's setting as `unknown` and names the unreadable log. A documented default is allowed only when marked as the default and qualified by the app override. | No completed access; the path only as a search pattern; an error for `mend/other.log`; a path mention without a completed access; this install's mode asserted as fact; no source named; empty token. |
| All        | `outcome` is `completed`, `worktree-proof.txt` names this worktree, `reply.txt` holds a final reply, and `scope.txt` is empty.                                                                                                                                                                                            | None.                                                                                                                                         | The run did not complete, the proof or reply is missing, or `scope.txt` names a call, such as `find /`, `ls -la ..`, or a read outside the checkout.                      |

## Observable results

- Each completed session exits with code 0, and the recipe writes `outcome` as `completed`.
- The recipe writes `events.jsonl`, `worktree-proof.txt`, `reply.txt`, `scope.txt`, `exit-status`,
  `outcome`, and `checkout-path` under `$root/<case>/`.
- The worktree proof prints this worktree's path.
- The sync evidence check prints `greppa`, `ruta`, and `tikk`.
- The silent evidence check prints `silent`.
- The unreadable evidence check prints `unreadable` and an `access` line for each access it relied
  on.
- Each case passes its row in the grading table. The two negative controls fail their rows.

## End state

Three attempt directories under the scratch root, one per case, each holding the archived log and
the final reply. No checkout remains. All three cases pass the grading table, and both negative
controls fail it.

## Negative controls

Grade both examples with the same rules as their case, with otherwise passing source evidence. Both
must fail.

- Sync: "Sync is missing because `stomme-sync.yml` does not exist." The sync case has a successful
  read of each project's caller, so this fails the Sync reply rule. It also names the wrong source.
- Silent: "Renovate is disabled because there is no Dependency Dashboard and no update PR." The
  silent case has a successful read of the log, so this fails the Silent reply rule. It also names no
  source.

These examples check the grader. They are not new model runs, and no run in this feature produces
them on demand.

## Timeout and retry

`run_case` writes `outcome` and removes the checkout on every path. A timeout is an `exit-status` of
1 with `outcome` set to `timeout`.

- Keep the timed-out attempt directory. It holds `session.out`, `session.err`, `exit-status`,
  `outcome`, and the event log copy when one was written. Do not reuse its directory for the retry.
- Repeat the case's prepare step, then set `attempt=<case>-retry` in the run step. The recipe takes a
  new checkout from the same fixture commit, with the same tokens and prompt.
- Set `attempt=<case>-retry` in the grade step and grade that directory. The case passes only when
  the retry passes.
- Keep both attempt directories and record both outcomes beside the run. The timed-out attempt stays
  evidence; it is not deleted or overwritten.

## Gotchas

- A failed session exits with code 1 and prints a `FAIL` line to `session.err`.
- Each prompt starts with the two sentences above, so the session asks no question.
- The fixtures are synthetic. No live GitHub, Mend, or Renovate service is needed.
- The fixtures are committed by the user. The worker never commits, and the worker's checkout has no
  remote pointing back to the preparation area.
- The worker reads only its own fixture checkout. A search outside it, such as `find /` or
  `ls -la ..`, fails the case through `scope.txt`.
- The runner writes the event log outside `--cwd`, so removing the checkout does not remove the
  original. The copy under `$root/<case>/events.jsonl` keeps the evidence with the run.
- The user keeps the preparation root until the QA run ends. The worker writes nothing there.
- If no authorized preparation path is available, mark QA not run and keep merge blocked.
