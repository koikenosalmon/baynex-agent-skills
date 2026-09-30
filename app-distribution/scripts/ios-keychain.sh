#!/usr/bin/env bash
# Installs / removes the managed manual-signing material written by ios-signing.mjs (temporary keychain + profiles).
# Usage: ios-keychain.sh install <signing-dir> | cleanup <signing-dir>
set -euo pipefail
mode=${1:?usage: ios-keychain.sh install|cleanup <signing-dir>}
dir=${2:?signing directory required}
keychain="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/baynex-ios-signing.keychain-db"
profile_dirs=("$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles")

case "$mode" in
  install)
    umask 077
    password=$(uuidgen)
    echo "::add-mask::$password" >&2
    security create-keychain -p "$password" "$keychain" >&2
    security set-keychain-settings -lut 21600 "$keychain" >&2
    security unlock-keychain -p "$password" "$keychain" >&2
    security import "$dir/signing.p12" -k "$keychain" -P "$(cat "$dir/p12-password")" -f pkcs12 -A -T /usr/bin/codesign -T /usr/bin/security >&2
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >&2
    existing=$(security list-keychains -d user | tr -d '"' | tr '\n' ' ')
    # shellcheck disable=SC2086
    security list-keychains -d user -s "$keychain" $existing >&2
    for target in "${profile_dirs[@]}"; do
      mkdir -p "$target"
      cp "$dir"/profiles/*.mobileprovision "$target/"
    done
    security find-identity -v -p codesigning "$keychain" >&2
    ;;
  cleanup)
    for file in "$dir"/profiles/*.mobileprovision; do
      [[ -e "$file" ]] || continue
      for target in "${profile_dirs[@]}"; do rm -f "$target/$(basename "$file")"; done
    done
    remaining=$(security list-keychains -d user | tr -d '"' | grep -vF "$keychain" | tr '\n' ' ' || true)
    # shellcheck disable=SC2086
    [[ -z "$remaining" ]] || security list-keychains -d user -s $remaining >&2 || true
    security delete-keychain "$keychain" >&2 2>/dev/null || true
    rm -rf "$dir"
    ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
