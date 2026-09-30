#!/usr/bin/env bash
# Frees disk on the GitHub-hosted ubuntu runner before the Android build. The runner ships ~14 GB free after
# the OS image; Flutter, Gradle caches, the APK and build logs can exhaust it ("No space left on device"),
# which kills the runner worker and leaves no logs. Only toolchains this kit's Android build never uses are removed.
# The Android SDK (platforms, build-tools, cmake) and the NDK are deliberately kept: the app's ndkVersion
# (flutter.ndkVersion) decides what it needs. Everything is best effort and never fails the job.
#   free-disk-space.sh
set -uo pipefail

if [[ "$(uname -s)" != Linux ]]; then echo 'not Linux; nothing to free'; exit 0; fi

echo '=== disk before ==='
df -h / "${RUNNER_TEMP:-/tmp}" 2>/dev/null || true

for path in \
  /usr/share/dotnet \
  /opt/ghc \
  /usr/local/.ghcup \
  /opt/hostedtoolcache/CodeQL \
  /usr/local/share/boost \
  /usr/share/swift; do
  if [[ -e "$path" ]]; then
    sudo -n rm -rf "$path" 2>/dev/null && echo "removed $path" || echo "could not remove $path (continuing)"
  fi
done

if command -v docker >/dev/null 2>&1; then
  sudo -n docker system prune --all --force >/dev/null 2>&1 && echo 'docker images pruned' || echo 'docker prune skipped'
fi

echo '=== disk after ==='
df -h / "${RUNNER_TEMP:-/tmp}" 2>/dev/null || true
exit 0
