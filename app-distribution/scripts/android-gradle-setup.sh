#!/usr/bin/env bash
# Bounds Gradle's memory on the 16 GB ubuntu runner and skips lint-vital for CI test builds.
# The app's own gradle.properties (Flutter template: -Xmx8G, Metaspace 4G) plus the Kotlin daemon, R8 and lint
# workers can exhaust the runner; the runner then dies with "received a shutdown signal" and leaves no logs.
# ~/.gradle/gradle.properties overrides the project-level file, so nothing in the app repo has to change.
#   android-gradle-setup.sh            write properties, init script and (best effort) swap
# Env: BAYNEX_ANDROID_LINT_VITAL=true keeps the lintVital* tasks; BAYNEX_SWAP_GB sets swap size (default 6, 0 = off).
set -uo pipefail

gradle_home="${GRADLE_USER_HOME:-$HOME/.gradle}"
mkdir -p "$gradle_home/init.d"

{
  echo 'org.gradle.vfs.watch=false'
  echo 'org.gradle.daemon=false'
  echo 'org.gradle.parallel=false'
  echo 'org.gradle.workers.max=2'
  echo 'org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8'
  echo 'kotlin.daemon.jvmargs=-Xmx2g'
} >> "$gradle_home/gradle.properties"

# lintVital* only re-runs the fatal-severity lint checks before a release build. This kit ships test builds to
# Firebase App Distribution, so the check is skipped by default (it is the memory-heaviest, silent phase).
# Trade-off: a fatal lint error is no longer caught here; run lint in the app's own CI if it matters.
cat > "$gradle_home/init.d/baynex-skip-lint-vital.gradle" <<'GRADLE'
if (System.getenv('BAYNEX_ANDROID_LINT_VITAL') != 'true') {
  allprojects {
    tasks.matching { it.name.startsWith('lintVital') }.configureEach { enabled = false }
  }
}
GRADLE

swap_gb="${BAYNEX_SWAP_GB:-6}"
if [[ "$swap_gb" =~ ^[1-9][0-9]?$ && "$(uname -s)" == Linux ]] && ! swapon --show 2>/dev/null | grep -q /baynex-swap; then
  if sudo -n fallocate -l "${swap_gb}G" /baynex-swap 2>/dev/null \
    && sudo -n chmod 600 /baynex-swap && sudo -n mkswap /baynex-swap >/dev/null 2>&1 && sudo -n swapon /baynex-swap 2>/dev/null; then
    echo "swap enabled: ${swap_gb} GB"
  else
    echo "swap not enabled (continuing without it)"
  fi
fi
free -m 2>/dev/null || true
