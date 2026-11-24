# Prompt in a Pi session

Target: pi-session

A `qa` worker runs this feature, for behavior that launches no worker. Change the prompt after its
first two sentences to trigger the changed behavior. The brief names the tools line and the reply
text that the changed prompt should produce.

## Entry points

`pnpm pi-session`, run in this worktree. It starts Pi in a scratch working directory and sends one
prompt.

## Driving steps

1. Set `run` to the run name from the brief, then create a scratch repository under the scratch
   root. It sets the path in `scratch`:

   ```sh
   run=<run>
   scratch=$(mktemp -d "/tmp/tau-verification-$run/qa-XXXXXX")
   git -C "$scratch" init --quiet
   ```

2. Run the session with the brief's model. Keep the first two sentences of the prompt, and replace
   the rest with the change that the brief names. It prints `Event log: <path>` after the reply. Set
   `log` to that path, then run the worktree proof from the [QA guide](../../qa.md#reach-it-1). It
   prints this worktree's path. The command below holds the prompt of the worked example.

   ```sh
   pnpm pi-session --cwd "$scratch" --model <pattern> --timeout 300 --prompt 'This is an automated check with no user present. Never call ask_user_question. Run the bash command "echo SESSION-OK" once. Then reply with only the output of the command.'
   ```

3. Run the tools check with the event log. Record the line it prints, then compare it with the
   tools line that the brief names.

   ```sh
   jq -c 'select(.type == "tool_execution_end") | [.toolName, .isError]' "$log"
   ```

4. Run the reply check from the [QA guide](../../qa.md#what-to-check-1). Record the text it prints,
   then compare it with the reply text that the brief names.

## Observable results

- The session command exits with code 0.
- The tools line matches the tools line that the brief names.
- The reply text matches the reply text that the brief names.

## Worked example

This example holds for the unchanged prompt only. The tools check prints `["bash",false]`, and the
reply check prints `SESSION-OK`.

## End state

The event log holds the tool calls that the brief names, and the reply is the text that the brief
names.

## Gotchas

- A failed session exits with code 1 and prints a `FAIL` line.
- The prompt starts with `This is an automated check with no user present. Never call
  ask_user_question.`, so the session asks no question.
