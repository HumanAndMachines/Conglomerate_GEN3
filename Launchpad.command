#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# GUI-launched macOS apps do not inherit the interactive shell PATH. Make the
# launcher self-contained enough for Dock/Finder opens where Bun lives in the
# standard user install location.
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun není nainstalovaný nebo není v PATH."
  echo "Nainstaluj Bun a spusť Launchpad znovu."
  read -r -p "Stiskni Enter pro zavření..." _
  exit 1
fi

bun run launchpad
