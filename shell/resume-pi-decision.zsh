# Pure resume decision for resume-pi.zsh. Prints one word: skip, retry, or resume.
# Args: terminal_id scope guard read session_label cwd_label recorded_pid current_pid
#       session_file_exists cwd_exists pi_available
_tau_resume_decision() {
  local terminal_id=$1
  local scope=$2
  local guard=$3
  local read=$4
  local session_label=$5
  local cwd_label=$6
  local recorded_pid=$7
  local current_pid=$8
  local session_file_exists=$9
  local cwd_exists=${10}
  local pi_available=${11}

  if [[ -z "$terminal_id" ]]; then
    print -r -- skip
    return 0
  fi

  if [[ "$guard" == "$scope/$terminal_id" ]]; then
    print -r -- skip
    return 0
  fi

  if [[ "$read" != "1" ]]; then
    print -r -- retry
    return 0
  fi

  if [[ -z "$session_label" ]]; then
    print -r -- skip
    return 0
  fi

  if [[ -z "$recorded_pid" ]]; then
    print -r -- retry
    return 0
  fi

  if [[ "$recorded_pid" != "$current_pid" ]]; then
    print -r -- skip
    return 0
  fi

  if [[ "$session_file_exists" != "1" ]]; then
    print -r -- skip
    return 0
  fi

  if [[ -z "$cwd_label" || "$cwd_exists" != "1" ]]; then
    print -r -- skip
    return 0
  fi

  if [[ "$pi_available" != "1" ]]; then
    print -r -- skip
    return 0
  fi

  print -r -- resume
}
