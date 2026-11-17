# Prompt in a Pi session

Target: pi-session

A `qa` worker runs this feature, for behavior that launches no worker. Change the prompt after its
first two sentences to trigger the changed behavior.

## Entry points

`pnpm pi-session`, run in this worktree. It starts Pi in a scratch working directory and sends one
prompt.

## Driving steps

1. Create a scratch repository under the scratch root. It prints the path:

   ```sh
   scratch=$(mktemp -d "/tmp/tau-verification-$run/qa-XXXXXX")
   git -C "$scratch" init --quiet
   ```

2. Run the session with the brief's model. It prints `Event log: <path>` after the reply. Set `log`
   to that path, then run the worktree proof from the [QA guide](../../qa.md#reach-it-1). It prints
   this worktree's path.

   ```sh
   pnpm pi-session --cwd "$scratch" --model <pattern> --timeout 300 --prompt 'This is an automated check with no user present. Never call ask_user_question. Run the bash command "echo SESSION-OK" once. Then reply with only the output of the command.'
   ```

3. Run the tools check with the event log. It prints `["bash",false]`.

   ```sh
   jq -c 'select(.type == "tool_execution_end") | [.toolName, .isError]' "$log"
   ```

4. Run the reply check from the [QA guide](../../qa.md#what-to-check-1). It prints `SESSION-OK`.

## Observable results

- The session command exits with code 0.
- The tools check prints `["bash",false]`.
- The reply check prints `SESSION-OK`.

## End state

The event log holds one bash call without an error, and the reply is exactly `SESSION-OK`.

## Gotchas

- A failed session exits with code 1 and prints a `FAIL` line.
- The prompt starts with the first two sentences above, so the session asks no question.
