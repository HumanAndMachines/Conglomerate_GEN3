#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SOURCE_DIR="$ROOT/scripts/macos"
APP_NAME="HumanAndMachine Launchpad.app"
INSTALL_SCHEMA="lazurio.launchpad.macos_install.v1"
BUILD_ROOT=""
BUILD_APP=""
BACKUP_PATH=""
FAILED_PATH=""
TARGET=""
HAD_TARGET=false
PUBLISHED_TARGET=false

show_error() {
  printf 'Launchpad macOS install: %s\n' "$1" >&2
}

cleanup() {
  if [[ -n "$BUILD_ROOT" && -d "$BUILD_ROOT" ]]; then
    case "$BUILD_ROOT" in
      */.humanandmachine-launchpad-install.*) rm -rf -- "$BUILD_ROOT" ;;
      *) show_error "Odmítám uklidit neočekávanou dočasnou cestu: $BUILD_ROOT" ;;
    esac
  fi
}

rollback() {
  if [[ "$PUBLISHED_TARGET" == true && -n "$TARGET" && -d "$TARGET" && ! -L "$TARGET" ]]; then
    if [[ "$HAD_TARGET" == true && -d "$BACKUP_PATH" && ! -L "$BACKUP_PATH" ]]; then
      if ! replace_app "$TARGET" "$BACKUP_PATH" "$(basename "$FAILED_PATH")"; then
        show_error "atomický rollback selhal; původní aplikace zůstává v $BACKUP_PATH."
      fi
    elif [[ "$HAD_TARGET" == false && -n "$BUILD_ROOT" ]]; then
      mv "$TARGET" "$BUILD_ROOT/failed-first-install.app" || true
    fi
  fi
  if [[ "$HAD_TARGET" == true && -n "$TARGET" && ! -e "$TARGET" && ! -L "$TARGET" && -d "$BACKUP_PATH" && ! -L "$BACKUP_PATH" ]]; then
    mv "$BACKUP_PATH" "$TARGET" || show_error "nouzové obnovení původní aplikace selhalo; zůstává v $BACKUP_PATH."
  fi
  if [[ -n "$FAILED_PATH" && -d "$FAILED_PATH" && ! -L "$FAILED_PATH" ]]; then
    rm -rf -- "$FAILED_PATH"
  fi
}

replace_app() {
  local target="$1"
  local replacement="$2"
  local backup_name="$3"
  /usr/bin/osascript -l JavaScript "$SOURCE_DIR/replace-app.jxa" \
    "$target" "$replacement" "$backup_name" >/dev/null
}

finish() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    rollback
  fi
  cleanup
  exit "$status"
}
trap finish EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  show_error "tento instalátor je určený pouze pro macOS."
  exit 1
fi

if [[ $# -ne 0 ]]; then
  show_error "instalátor nepřijímá vlastní cíl; aplikace vždy patří do uživatelského ~/Applications."
  exit 1
fi

if [[ "$ROOT" == *$'\n'* ]]; then
  show_error "kanonická cesta Lazurio rootu nesmí obsahovat nový řádek."
  exit 1
fi

if [[ ! -f "$ROOT/package.json" || -L "$ROOT/package.json" ]]; then
  show_error "root není úplný; chybí bezpečný $ROOT/package.json."
  exit 1
fi
if [[ ! -d "$ROOT/launchpad" || -L "$ROOT/launchpad" ]]; then
  show_error "root není úplný; chybí bezpečný $ROOT/launchpad."
  exit 1
fi
if [[ ! -f "$ROOT/Launchpad.command" || -L "$ROOT/Launchpad.command" || ! -x "$ROOT/Launchpad.command" ]]; then
  show_error "root launcher není spustitelný: $ROOT/Launchpad.command"
  exit 1
fi

GIT_MARKER="$ROOT/.git"
if [[ -L "$GIT_MARKER" ]]; then
  show_error "Git metadata rootu nesmí být symlink."
  exit 1
fi
if [[ -f "$GIT_MARKER" ]]; then
  IFS= read -r GIT_LINE < "$GIT_MARKER" || true
  case "$GIT_LINE" in
    "gitdir: "*) GIT_DIR_VALUE="${GIT_LINE#gitdir: }" ;;
    *)
      show_error "Git metadata marker rootu je neplatný."
      exit 1
      ;;
  esac
  if [[ "$GIT_DIR_VALUE" = /* ]]; then
    GIT_DIR="$GIT_DIR_VALUE"
  else
    GIT_DIR="$ROOT/$GIT_DIR_VALUE"
  fi
  if [[ ! -d "$GIT_DIR" ]]; then
    show_error "Git metadata adresář rootu není dostupný."
    exit 1
  fi
  GIT_DIR="$(cd "$GIT_DIR" && pwd -P)"
  if [[ -f "$GIT_DIR/commondir" ]]; then
    show_error "instalace z linked worktree je zakázaná; spusť ji z primárního Lazurio checkoutu."
    exit 1
  fi
elif [[ -e "$GIT_MARKER" && ! -d "$GIT_MARKER" ]]; then
  show_error "Git metadata rootu mají nepodporovaný typ."
  exit 1
fi

if [[ -z "${HOME:-}" || "$HOME" != /* || ! -d "$HOME" || "$HOME" == *$'\n'* ]]; then
  show_error "uživatelský HOME není platná absolutní cesta."
  exit 1
fi
HOME_CANONICAL="$(cd "$HOME" && pwd -P)"
TARGET_PARENT="$HOME_CANONICAL/Applications"
if [[ -L "$TARGET_PARENT" ]]; then
  show_error "uživatelský Applications adresář nesmí být symlink."
  exit 1
fi
mkdir -p "$TARGET_PARENT"
if [[ "$(cd "$TARGET_PARENT" && pwd -P)" != "$TARGET_PARENT" ]]; then
  show_error "uživatelský Applications adresář není kanonický."
  exit 1
fi
TARGET="$TARGET_PARENT/$APP_NAME"
if [[ -L "$TARGET" ]]; then
  show_error "cílová aplikace nesmí být symlink."
  exit 1
fi
if [[ -e "$TARGET" && ! -d "$TARGET" ]]; then
  show_error "existující cíl není aplikace-adresář: $TARGET"
  exit 1
fi
BACKUP_PATH="$TARGET_PARENT/.humanandmachine-launchpad-rollback"
FAILED_PATH="$TARGET_PARENT/.humanandmachine-launchpad-failed"
for managed_path in "$BACKUP_PATH" "$FAILED_PATH"; do
  if [[ -L "$managed_path" || ( -e "$managed_path" && ! -d "$managed_path" ) ]]; then
    show_error "spravovaná cesta instalátoru nemá bezpečný adresářový typ: $managed_path"
    exit 1
  fi
done

for source in launchpad-bootstrap.sh replace-app.jxa Info.plist; do
  if [[ ! -f "$SOURCE_DIR/$source" || -L "$SOURCE_DIR/$source" ]]; then
    show_error "chybí bezpečný zdroj macOS launcheru: $SOURCE_DIR/$source"
    exit 1
  fi
done

BUILD_ROOT="$(mktemp -d "$TARGET_PARENT/.humanandmachine-launchpad-install.XXXXXX")"
BUILD_APP="$BUILD_ROOT/$APP_NAME"
mkdir -p "$BUILD_APP/Contents/MacOS" "$BUILD_APP/Contents/Resources"
cp "$SOURCE_DIR/launchpad-bootstrap.sh" "$BUILD_APP/Contents/MacOS/launchpad-bootstrap"
cp "$SOURCE_DIR/Info.plist" "$BUILD_APP/Contents/Info.plist"
chmod +x "$BUILD_APP/Contents/MacOS/launchpad-bootstrap"
printf '%s\n' "$ROOT" > "$BUILD_APP/Contents/Resources/root-path"
printf '%s\n' "$INSTALL_SCHEMA" > "$BUILD_APP/Contents/Resources/install-schema"

/usr/bin/plutil -lint "$BUILD_APP/Contents/Info.plist" >/dev/null
/usr/bin/codesign --force --deep --sign - "$BUILD_APP" >/dev/null
/usr/bin/codesign --verify --deep --strict "$BUILD_APP"

if [[ -d "$TARGET" ]]; then
  HAD_TARGET=true
  if [[ -d "$BACKUP_PATH" ]]; then
    rm -rf -- "$BACKUP_PATH"
  fi
  if [[ -d "$FAILED_PATH" ]]; then
    rm -rf -- "$FAILED_PATH"
  fi
  replace_app "$TARGET" "$BUILD_APP" "$(basename "$BACKUP_PATH")"
else
  mv "$BUILD_APP" "$TARGET"
fi
PUBLISHED_TARGET=true
/usr/bin/codesign --verify --deep --strict "$TARGET"
if [[ "$(<"$TARGET/Contents/Resources/root-path")" != "$ROOT" ]]; then
  show_error "aktivovaný launcher neukazuje na očekávaný Lazurio root."
  exit 1
fi
if [[ "$(<"$TARGET/Contents/Resources/install-schema")" != "$INSTALL_SCHEMA" ]]; then
  show_error "aktivovaný launcher nemá očekávaný instalační kontrakt."
  exit 1
fi

printf 'HumanAndMachine Launchpad je nainstalovaný v: %s\n' "$TARGET"
if [[ "$HAD_TARGET" == true ]]; then
  printf 'Předchozí aplikace zůstala jako rollback záloha: %s\n' "$BACKUP_PATH"
fi
if [[ -e "/Applications/Launchpad GEN3.app" || -e "$TARGET_PARENT/Launchpad GEN3.app" ]]; then
  printf 'Upozornění: starší Launchpad GEN3.app zůstává beze změny. V Docku používej novou aplikaci z uživatelského Applications.\n' >&2
fi
