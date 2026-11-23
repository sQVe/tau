# Question gate shadow score

Target: none

A `qa` worker runs this feature. The command reads shadow records and makes no model calls.

## Entry points

`node "$checkout/scripts/questionGateScore.ts" --shadow`, run from a scratch Git repository with an isolated `PI_CODING_AGENT_DIR`.

## Driving steps

1. Set `run` to the run name from the brief and `checkout` to this worktree. Create a scratch repository, an isolated agent directory, an evidence directory, and the shadow record directory.

```sh
run=<run>
checkout=<worktree path from the brief>
mkdir -p "/tmp/tau-verification-$run"
scratch=$(mktemp -d "/tmp/tau-verification-$run/qa-XXXXXX")
agent=$(mktemp -d "/tmp/tau-verification-$run/agent-XXXXXX")
evidence=$(mktemp -d "/tmp/tau-verification-$run/evidence-XXXXXX")
git -C "$scratch" init --quiet
mkdir -p "$scratch/.tau/questions"
```

2. Write `$agent/tau.json`. The replay checks no model allowlist and needs no API key.

```sh
cat > "$agent/tau.json" <<'CONFIG'
{
  "questionGate": {
    "classifier": "fixture/classifier",
    "panel": ["fixture/panel-a", "fixture/panel-b", "fixture/panel-c"],
    "shadow": { "variant": "classifier", "cutoff": 0.8 }
  }
}
CONFIG
```

3. Compute the frozen cohort from that config.

```sh
cohort=$(cd "$checkout" && PI_CODING_AGENT_DIR="$agent" node --input-type=module -e '
import { readQuestionGateShadow, shadowCohort } from "./src/config/questionGateModels.ts";
const config = readQuestionGateShadow({ cwd: process.cwd(), agentDirectory: process.env.PI_CODING_AGENT_DIR, projectTrusted: false }, { notify: (message) => console.error(message) });
if (config === undefined) throw new Error("questionGate.shadow is missing");
console.log(shadowCohort(config));
')
```

4. Write two decided records from separate sessions, one record from another cohort, and one malformed peer. The question has one recommended option.

```sh
cat > "$scratch/.tau/questions/shadow-00000001-0000-4000-8000-000000000000.json" <<RECORD
{"version":1,"kind":"shadow","cohort":"$cohort","sessionId":"session-a","question":{"question":"Which database should the service use?","problem":"The service ships next week.","impact":"Changing the database later moves every stored row.","options":[{"label":"Postgres","description":"One primary.","recommended":true},{"label":"MySQL","description":"One primary with another dialect.","recommended":false}]},"confidence":0.9,"judges":{"classifier":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":10},"classifierExamples":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":10},"panel":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":10},"panelExamples":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":10},"agent":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":0}},"answer":{"kind":"answered","selected":["Postgres"],"typed":false}}
RECORD

cat > "$scratch/.tau/questions/shadow-00000002-0000-4000-8000-000000000000.json" <<RECORD
{"version":1,"kind":"shadow","cohort":"$cohort","sessionId":"session-b","question":{"question":"Which database should the service use?","problem":"The service ships next week.","impact":"Changing the database later moves every stored row.","options":[{"label":"Postgres","description":"One primary.","recommended":true},{"label":"MySQL","description":"One primary with another dialect.","recommended":false}]},"confidence":0.9,"judges":{"classifier":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":30},"classifierExamples":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":30},"panel":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":30},"panelExamples":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":30},"agent":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":0}},"answer":{"kind":"answered","selected":["Postgres"],"typed":false}}
RECORD

cat > "$scratch/.tau/questions/shadow-00000003-0000-4000-8000-000000000000.json" <<RECORD
{"version":1,"kind":"shadow","cohort":"another-cohort","sessionId":"session-c","question":{"question":"Which database should the service use?","problem":"The service ships next week.","impact":"Changing the database later moves every stored row.","options":[{"label":"Postgres","description":"One primary.","recommended":true},{"label":"MySQL","description":"One primary with another dialect.","recommended":false}]},"confidence":0.9,"judges":{"classifier":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":500},"classifierExamples":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":500},"panel":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":500},"panelExamples":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":500},"agent":{"verdict":{"kind":"answered","confidence":0.9},"milliseconds":0}},"answer":{"kind":"answered","selected":["Postgres"],"typed":false}}
RECORD

printf '%s\n' '{"version":1' > "$scratch/.tau/questions/shadow-00000004-0000-4000-8000-000000000000.json"
```

5. Record the files, run the command from the scratch repository, and record the files again. The command writes nothing.

```sh
find "$scratch" "$agent" -type f -exec sha256sum {} + | sort > "$evidence/before.txt"

cd "$scratch"
PI_CODING_AGENT_DIR="$agent" node "$checkout/scripts/questionGateScore.ts" --shadow > "$evidence/stdout.txt" 2> "$evidence/stderr.txt"
printf '%s\n' "$?" > "$evidence/exit-code.txt"

find "$scratch" "$agent" -type f -exec sha256sum {} + | sort > "$evidence/after.txt"
diff -u "$evidence/before.txt" "$evidence/after.txt" > "$evidence/files.diff"
```

## Observable results

- `$evidence/exit-code.txt` holds `0`.
- `$evidence/stdout.txt` holds `Sampled dialogs: 2`, `Agreement: 100.0%`, `95% lower bound: 13.5%`, `Potential saves: 2 (100.0% of sampled dialogs)`, and `Judge time: 20.0 ms mean`.
- `$evidence/stderr.txt` holds `Excluded 1 shadow records from other cohorts.` and one `Shadow record warning:` line.
- `$evidence/files.diff` is empty.

## End state

The scratch repository still holds the two cohort records, the other-cohort record, and the malformed peer. The evidence directory holds the command output, the exit code, and the before-and-after file lists.

## Gotchas

- The command needs no allowed model list and no API key.
- A record from another cohort changes no metric and appears only in the excluded count.
- A malformed record prints a warning and does not fail the command.
- The command refuses to read through a symlink under `.tau/questions`.
