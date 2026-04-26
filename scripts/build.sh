#!/usr/bin/env bash
# build.sh — package the extension and (optionally) (re)install it into VS Code
#
# Usage:
#   scripts/build.sh                  # package only → ./nutshell-vscode-<ver>.vsix
#   scripts/build.sh --install        # package + install via `code --install-extension`
#   scripts/build.sh --install --reload  # also reload the active VS Code window
#   scripts/build.sh --uninstall      # remove the extension before installing
#
# Requires: `vsce` (npm i -g @vscode/vsce) and the `code` CLI on PATH.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

INSTALL=0
RELOAD=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install)   INSTALL=1 ;;
    --reload)    RELOAD=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').name")"
VSIX="${ROOT}/${NAME}-${VERSION}.vsix"
PUBLISHER="$(node -p "require('./package.json').publisher")"
EXT_ID="${PUBLISHER}.${NAME}"

echo "→ packaging ${NAME}@${VERSION}"
# Clean stale .vsix for the same version so we get a deterministic file.
rm -f "${VSIX}"
npx --no-install vsce package --allow-missing-repository --skip-license --out "${VSIX}" >/dev/null
echo "  ${VSIX}"

if [[ "${UNINSTALL}" -eq 1 ]]; then
  echo "→ uninstalling ${EXT_ID} (if installed)"
  code --uninstall-extension "${EXT_ID}" >/dev/null 2>&1 || true
fi

if [[ "${INSTALL}" -eq 1 ]]; then
  if ! command -v code >/dev/null 2>&1; then
    echo "‼ 'code' CLI not on PATH — open VS Code → Cmd+Shift+P → 'Shell Command: Install code command in PATH'." >&2
    exit 1
  fi
  echo "→ installing ${VSIX} into VS Code"
  code --install-extension "${VSIX}" --force
  echo "  installed. Run 'Developer: Reload Window' (Cmd+R in dev host) to pick up changes."
fi

if [[ "${RELOAD}" -eq 1 ]]; then
  if command -v osascript >/dev/null 2>&1; then
    echo "→ asking the active VS Code window to reload"
    osascript -e 'tell application "Visual Studio Code" to activate' \
      -e 'tell application "System Events" to keystroke "p" using {command down, shift down}' \
      -e 'delay 0.4' \
      -e 'tell application "System Events" to keystroke "Developer: Reload Window"' \
      -e 'delay 0.2' \
      -e 'tell application "System Events" to key code 36' >/dev/null 2>&1 || true
  fi
fi

echo "✓ done"
