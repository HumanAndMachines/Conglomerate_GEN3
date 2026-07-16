#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun není nainstalovaný nebo není v PATH."
  exit 1
fi

bun run launchpad
