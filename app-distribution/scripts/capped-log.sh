#!/usr/bin/env bash
# Like `tee`, but the file never holds more than about <max-mb> MB: stdin is copied to stdout unchanged and to
# <file>; when the file reaches half the budget it is rotated to <file>.1 (the previous .1 is dropped), so the
# newest output is always kept. Keeps `flutter build apk --verbose` from filling the runner disk.
#   some-command 2>&1 | capped-log.sh <file> [max-mb]
set -uo pipefail
file=${1:-}
max_mb=${2:-50}
if [[ -z "$file" ]]; then echo '使い方: capped-log.sh <file> [max-mb]' >&2; exit 2; fi
[[ "$max_mb" =~ ^[1-9][0-9]{0,3}$ ]] || max_mb=50
mkdir -p "$(dirname "$file")"
awk -v file="$file" -v limit=$((max_mb * 1024 * 1024 / 2)) '
  BEGIN { bytes = 0 }
  {
    print; fflush()
    print > file; fflush(file)
    bytes += length($0) + 1
    if (bytes >= limit) { close(file); system("mv -f \"" file "\" \"" file ".1\""); bytes = 0 }
  }
'
