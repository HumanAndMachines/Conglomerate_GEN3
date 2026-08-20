#!/bin/bash
set -euo pipefail

CONTENTS_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
ROOT_FILE="$CONTENTS_DIR/Resources/root-path"
SCHEMA_FILE="$CONTENTS_DIR/Resources/install-schema"
EXPECTED_SCHEMA="lazurio.launchpad.macos_install.v1"

fail() {
  local message="$1"
  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'display dialog (item 1 of argv) buttons {"OK"} default button "OK" with icon stop' \
    -e 'end run' \
    "$message" >/dev/null 2>&1 || true
  printf '%s\n' "$message" >&2
  exit 1
}

if [[ ! -f "$ROOT_FILE" || -L "$ROOT_FILE" || ! -f "$SCHEMA_FILE" || -L "$SCHEMA_FILE" ]]; then
  fail "Lazurio Launchpad nemá platnou instalaci. V primárním Lazurio checkoutu spusť bun run install:macos-app."
fi
ROOT_LINE_COUNT="$(/usr/bin/wc -l < "$ROOT_FILE" | /usr/bin/tr -d '[:space:]')"
SCHEMA_LINE_COUNT="$(/usr/bin/wc -l < "$SCHEMA_FILE" | /usr/bin/tr -d '[:space:]')"
if [[ "$ROOT_LINE_COUNT" != "1" || "$SCHEMA_LINE_COUNT" != "1" ]]; then
  fail "Lazurio Launchpad má neplatný víceřádkový instalační kontrakt. Spusť znovu bun run install:macos-app."
fi

IFS= read -r ROOT < "$ROOT_FILE" || true
IFS= read -r SCHEMA < "$SCHEMA_FILE" || true
if [[ -z "$ROOT" || "$ROOT" == *$'\n'* || "$SCHEMA" != "$EXPECTED_SCHEMA" ]]; then
  fail "Lazurio Launchpad má neplatný instalační kontrakt. Spusť znovu bun run install:macos-app."
fi
if [[ ! -d "$ROOT" ]]; then
  fail "Nakonfigurovaný Lazurio root není dostupný: $ROOT"
fi

CANONICAL_ROOT="$(cd "$ROOT" && pwd -P)"
if [[ "$CANONICAL_ROOT" != "$ROOT" ]]; then
  fail "Nakonfigurovaný Lazurio root už není kanonický. Spusť znovu bun run install:macos-app."
fi

LAUNCHER="$CANONICAL_ROOT/Launchpad.command"
if [[ ! -f "$LAUNCHER" || -L "$LAUNCHER" || ! -x "$LAUNCHER" ]]; then
  fail "V nakonfigurovaném Lazurio rootu chybí spustitelný Launchpad.command."
fi

# Launchpad.command je jediný human launcher. Ten resolveuje Bun a předává
# start/reuse/upgrade rozhodnutí Core-owned Server identity handshaku.
if ! /usr/bin/open "$LAUNCHER"; then
  fail "Launchpad.command se nepodařilo otevřít. Spusť ho přímo z Lazurio rootu a zkontroluj chybu."
fi
