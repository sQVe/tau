{
  () {
    source "${${(%):-%x}:A:h}/resume-pi-decision.zsh"

    local terminal_id=${HC_TERMINAL_ID:-}
    local scope=${HC_SCOPE:-}
    local guard=${TAU_RESUME_PI_DONE:-}
    local current_pid=$$
    local decision

    decision=$(_tau_resume_decision "$terminal_id" "$scope" "$guard" 0 '' '' '' "$current_pid" 0 0 0)

    if [[ "$decision" != 'retry' ]]; then
      return 0
    fi

    export TAU_RESUME_PI_DONE="$scope/$terminal_id"

    if ! command -v jq >/dev/null 2>&1; then
      return 0
    fi

    if ! command -v timeout >/dev/null 2>&1; then
      return 0
    fi

    if ! zmodload zsh/datetime 2>/dev/null; then
      return 0
    fi

    local wait_value=${TAU_RESUME_WAIT_SECONDS:-4}

    if [[ "$wait_value" != <1-10> ]]; then
      wait_value=4
    fi

    local -i wait_seconds=$wait_value
    local -F deadline=$((EPOCHREALTIME + wait_seconds))
    local -F remaining
    local terminal_json=''
    local terminal_read=0
    local session_label=''
    local cwd_label=''
    local recorded_pid=''
    local session_file_exists=0
    local cwd_exists=0
    local pi_available=0

    while true; do
      remaining=$((deadline - EPOCHREALTIME))

      if (( remaining < 0.35 )); then
        break
      fi

      if terminal_json="$(timeout "$remaining" hc get "$terminal_id" --json 2>/dev/null)" && print -r -- "$terminal_json" | jq -e . >/dev/null 2>&1; then
        terminal_read=1
      else
        terminal_read=0
        terminal_json=''
      fi

      session_label="$(print -r -- "$terminal_json" | jq -r '.labels["pi.session"] // empty' 2>/dev/null)"
      cwd_label="$(print -r -- "$terminal_json" | jq -r '.labels["pi.cwd"] // empty' 2>/dev/null)"
      recorded_pid="$(print -r -- "$terminal_json" | jq -r '.pid // empty' 2>/dev/null)"

      if [[ -f "$session_label" ]]; then
        session_file_exists=1
      else
        session_file_exists=0
      fi

      if [[ -d "$cwd_label" ]]; then
        cwd_exists=1
      else
        cwd_exists=0
      fi

      if command -v pi >/dev/null 2>&1; then
        pi_available=1
      else
        pi_available=0
      fi

      decision=$(
        _tau_resume_decision \
          "$terminal_id" "$scope" "$guard" "$terminal_read" "$session_label" "$cwd_label" "$recorded_pid" \
          "$current_pid" "$session_file_exists" "$cwd_exists" "$pi_available"
      )

      if [[ "$decision" == 'resume' ]]; then
        cd -- "$cwd_label" || return 0

        pi --session "$session_label"
        break
      fi

      if [[ "$decision" == 'skip' ]]; then
        break
      fi

      sleep 0.25
    done
  }
} always {
  unfunction _tau_resume_decision 2>/dev/null
}
