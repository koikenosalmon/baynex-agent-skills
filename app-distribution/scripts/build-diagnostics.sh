#!/usr/bin/env bash
# Evidence for build steps that hang: periodic process and thread snapshots while the build runs,
# and a one-shot collection of Gradle daemon logs afterwards. Nothing here is required for the build.
#   build-diagnostics.sh sample <directory> [interval-seconds]   loops until killed
#   build-diagnostics.sh collect <directory>
set -uo pipefail

command=${1:-}
directory=${2:-}
if [[ -z "$directory" ]]; then echo '使い方: build-diagnostics.sh sample|collect <directory> [interval-seconds]' >&2; exit 2; fi
mkdir -p "$directory"

# Diagnostics must never fill the disk they are diagnosing: keep only the newest 5 MB of a file.
cap_file() {
  local file=$1
  if [[ -f "$file" && $(wc -c < "$file") -gt 5242880 ]]; then
    tail -c 5242880 "$file" > "$file.tmp" && mv -f "$file.tmp" "$file"
  fi
}

case "$command" in
  sample)
    # Memory every $interval seconds (default 60) to the log file AND stdout (the job log survives a runner that
    # dies); the heavier process table and thread dumps every fifth sample.
    interval=${3:-60}
    [[ "$interval" =~ ^[1-9][0-9]{0,4}$ ]] || interval=60
    count=0
    while sleep "$interval"; do
      count=$((count + 1))
      {
        echo "=== memory $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
        free -m 2>/dev/null || true
        df -h / "${RUNNER_TEMP:-/tmp}" 2>/dev/null || true
        ps -eo pid,rss,pmem,etimes,comm --sort=-rss 2>/dev/null | head -6 || true
      } 2>&1 | tee -a "$directory/memory-samples.log"
      cap_file "$directory/memory-samples.log"
      if (( count % 5 == 0 )); then
        {
          echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
          ps -eo pid,ppid,etimes,stat,pcpu,pmem,comm 2>/dev/null | head -60
          df -h "${RUNNER_TEMP:-/tmp}" 2>/dev/null || true
          if command -v jcmd >/dev/null 2>&1; then
            for pid in $(pgrep -f 'GradleDaemon|GradleWrapperMain' 2>/dev/null || true); do
              echo "--- thread dump pid=$pid ---"
              timeout 30 jcmd "$pid" Thread.print 2>&1 | head -400
            done
          fi
        } >> "$directory/process-samples.log" 2>&1
        cap_file "$directory/process-samples.log"
      fi
    done
    ;;
  collect)
    {
      echo "inotify max_user_watches: $(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo n/a)"
      echo "inotify max_user_instances: $(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo n/a)"
      ulimit -a 2>/dev/null || true
    } > "$directory/limits.txt" 2>&1
    for file in "$HOME"/.gradle/daemon/*/daemon-*.out.log "$HOME"/.gradle/gradle.properties "$HOME"/.gradle/init.d/*.gradle; do
      [[ -f "$file" ]] && cp "$file" "$directory/$(echo "${file#"$HOME"/}" | tr '/' '_')"
    done
    find "${GITHUB_WORKSPACE:-.}" -maxdepth 4 \( -name 'hs_err_pid*.log' -o -name 'replay_pid*.log' \) -exec cp {} "$directory/" \; 2>/dev/null || true
    ;;
  *)
    echo '使い方: build-diagnostics.sh sample|collect <directory> [interval-seconds]' >&2
    exit 2
    ;;
esac
