#!/usr/bin/env bash
set -euo pipefail

# CI checks out the full history (fetch-depth: 0) so release merge metadata is complete.
clean() {
  local value=$1 limit=$2
  value=${value//$'\r'/ }
  value=${value//$'\n'/ }
  value=$(printf '%s' "$value" | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177')
  printf '%s' "${value:0:limit}"
}
theme_branch() {
  [[ $1 =~ ^ai/feature-[A-Za-z0-9._/-]+$ || $1 =~ ^feature/[A-Za-z0-9._/-]+$ || $1 =~ ^epic/[A-Za-z0-9._/-]+$ ]]
}
csv_limit() {
  local result='' item
  while IFS= read -r item; do
    [[ -n $item ]] || continue
    if (( ${#result} + ${#item} + (${#result} > 0 ? 1 : 0) > 200 )); then continue; fi
    [[ -z $result ]] && result=$item || result+=",$item"
  done
  printf '%s' "$result"
}

branch=$(clean "${GITHUB_REF_NAME:-$(git branch --show-current)}" 200)
commit=${GITHUB_SHA:-$(git rev-parse HEAD)}
[[ $commit =~ ^[0-9a-fA-F]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
server=${GITHUB_SERVER_URL:-https://github.com}
repository=${GITHUB_REPOSITORY:-}
run_id=${GITHUB_RUN_ID:-}

echo '最近の変更:'
while IFS= read -r subject; do
  [[ -n $subject ]] && printf -- '- %s\n' "$(clean "$subject" 160)"
done < <(git log -5 --no-merges --format=%s HEAD)
echo
echo '[baynex]'
printf 'branch: %s\ncommit: %s\n' "$branch" "$(printf '%s' "$commit" | tr 'A-F' 'a-f')"
if [[ $server == https://github.com && $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $run_id =~ ^[0-9]+$ ]]; then
  printf 'run: %s/%s/actions/runs/%s\n' "$server" "$repository" "$run_id"
fi
if [[ $branch == release/* ]]; then
  version=$(clean "${branch#release/}" 80)
  [[ -n $version ]] && printf 'version: %s\n' "$version"
fi

# Collect task IDs from recent subjects. Keep whole IDs and stop before the 200-character field limit.
tasks=$(git log -200 --format=%s HEAD | sed -nE 's/^Implement ([A-Za-z0-9_-]+)$/\1/p; s#.*ai/task-([A-Za-z0-9_-]+).*#\1#p' | LC_ALL=C sort -u | csv_limit)
[[ -z $tasks ]] || printf 'tasks: %s\n' "$tasks"
# A squash commit may carry a Baynex theme ID rather than a recoverable branch name.
theme_id=$(git log -200 --format=%b HEAD | sed -nE 's/^Baynex-Theme:[[:space:]]*([A-Za-z0-9_-]+)[[:space:]]*$/\1/p' | sed -n '1p')
[[ -z $theme_id ]] || printf 'theme: %s\n' "$(clean "$theme_id" 200)"

if [[ $branch == release/* ]]; then
  history=$(mktemp)
  remote=$(mktemp)
  merge_branch_re="^Merge branch '([^']+)'"
  trap 'rm -f "$history" "$remote"' EXIT
  while IFS= read -r -d '' subject && IFS= read -r -d '' body; do
    while [[ $subject == $'\n'* ]]; do subject=${subject#$'\n'}; done
    candidate=''
    if [[ $subject =~ ^Merge\ pull\ request\ \#[0-9]+\ from\ [^/]+/(.+)$ ]]; then
      candidate=${BASH_REMATCH[1]}
    elif [[ $subject =~ $merge_branch_re ]]; then
      candidate=${BASH_REMATCH[1]}
    fi
    if theme_branch "$candidate"; then printf '%s\n' "$candidate" >> "$history"; fi
    while IFS= read -r line; do
      if [[ $line =~ ^Baynex-Theme:[[:space:]]*(.+)$ ]]; then
        candidate=$(clean "${BASH_REMATCH[1]}" 200)
        if theme_branch "$candidate"; then printf '%s\n' "$candidate" >> "$history"; fi
      fi
    done <<< "$body"
  done < <(git log --format='%s%x00%b%x00' HEAD)
  git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin > "$remote"
  merged=''
  changed=''
  while IFS= read -r candidate; do
    theme_branch "$candidate" || continue
    if git show-ref --verify --quiet "refs/remotes/origin/$candidate"; then
      if git merge-base --is-ancestor "refs/remotes/origin/$candidate" HEAD; then
        merged+="$candidate"$'\n'
      elif grep -Fxq "$candidate" "$history"; then
        changed+="$candidate"$'\n'
      fi
    elif grep -Fxq "$candidate" "$history"; then
      merged+="$candidate"$'\n'
    fi
  done < <(cat "$history" "$remote" | LC_ALL=C sort -u)
  merged=$(printf '%s\n' "$merged" | csv_limit)
  changed=$(printf '%s\n' "$changed" | csv_limit)
  [[ -z $merged ]] || printf 'merged: %s\n' "$merged"
  [[ -z $changed ]] || printf 'changed-after-merge: %s\n' "$changed"
fi
