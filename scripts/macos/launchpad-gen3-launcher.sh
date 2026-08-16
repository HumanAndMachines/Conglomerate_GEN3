#!/usr/bin/env bash
set -euo pipefail

CONTENTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_FILE="$CONTENTS_DIR/Resources/root-path"
JOB_LABEL_FILE="$CONTENTS_DIR/Resources/job-label"
JOB_PLIST="$CONTENTS_DIR/Resources/LaunchAgent.plist"
LOG_DIR="$HOME/Library/Logs/HumanAndMachine"
LOG_PATH="$LOG_DIR/launchpad-gen3.log"

show_error() {
  local message="$1"
  /usr/bin/osascript -e 'on run argv' -e 'display dialog (item 1 of argv) buttons {"OK"} default button "OK" with icon stop' -e 'end run' "$message" >/dev/null 2>&1 || true
}

mkdir -p "$LOG_DIR"

if [[ ! -f "$ROOT_FILE" || ! -f "$JOB_LABEL_FILE" || ! -f "$JOB_PLIST" ]]; then
  show_error "Launchpad GEN3 nemá uloženou cestu ke Konglomerátu. Přeinstalujte jeho Dock aplikaci."
  exit 1
fi

IFS= read -r ROOT < "$ROOT_FILE"
IFS= read -r JOB_LABEL < "$JOB_LABEL_FILE"
if [[ ! -f "$ROOT/package.json" || ! -d "$ROOT/launchpad" ]]; then
  show_error "Launchpad GEN3 nemůže najít Konglomerát v cestě: $ROOT"
  exit 1
fi

# Finder a Dock nepřebírají PATH z interaktivního shellu.
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin"

if ! command -v bun >/dev/null 2>&1; then
  show_error "Launchpad GEN3 potřebuje Bun. Nainstalujte jej a spusťte Launchpad znovu."
  exit 1
fi

CANONICAL_ROOT="$(cd "$ROOT" && pwd -P)"
ROOT_ID="$(printf '%s' "$CANONICAL_ROOT" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"

# Nejdřív najdi už běžící instanci stejného checkoutu. Port je runtime detail,
# nikoli identita Launchpadu, proto procházíme stejný omezený fallback rozsah
# jako server a ověřujeme hash kanonického rootu.
for PORT in $(/usr/bin/seq 4174 4193); do
  URL="http://127.0.0.1:$PORT"
  IDENTITY="$(/usr/bin/curl -fsS --max-time 1 "$URL/api/launchpad/identity" 2>/dev/null || true)"
  if [[ "$IDENTITY" == *"\"root_id\":\"$ROOT_ID\""* ]]; then
    /usr/bin/open "$URL/"
    exit 0
  fi
done

# LaunchAgent převezme vlastnictví serveru, aby jeho život nebyl svázaný s
# krátkým procesem Dock aplikace. Bootstrap je idempotentní přes print/kickstart.
DOMAIN="gui/$(/usr/bin/id -u)"
SERVICE="$DOMAIN/$JOB_LABEL"
if /bin/launchctl print "$SERVICE" >/dev/null 2>&1; then
  /bin/launchctl kickstart "$SERVICE"
else
  if ! /bin/launchctl bootstrap "$DOMAIN" "$JOB_PLIST" >> "$LOG_PATH" 2>&1; then
    show_error "Launchpad GEN3 se nepodařilo předat uživatelské službě. Detail je v $LOG_PATH."
    exit 1
  fi
fi
