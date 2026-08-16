#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT/scripts/macos"
TARGET="${1:-/Applications/Launchpad GEN3.app}"
BUILD_DIR="$(mktemp -d)"
BUILD_APP="$BUILD_DIR/Launchpad GEN3.app"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Tento instalátor je určený pouze pro macOS." >&2
  exit 1
fi

for source in launchpad-gen3-launcher.sh Info.plist LaunchAgent.plist; do
  if [[ ! -f "$SOURCE_DIR/$source" ]]; then
    echo "Chybí zdroj macOS launcheru: $SOURCE_DIR/$source" >&2
    exit 1
  fi
done

mkdir -p "$BUILD_APP/Contents/MacOS" "$BUILD_APP/Contents/Resources"
cp "$SOURCE_DIR/launchpad-gen3-launcher.sh" "$BUILD_APP/Contents/MacOS/launchpad-gen3"
cp "$SOURCE_DIR/Info.plist" "$BUILD_APP/Contents/Info.plist"
cp "$SOURCE_DIR/LaunchAgent.plist" "$BUILD_APP/Contents/Resources/LaunchAgent.plist"
chmod +x "$BUILD_APP/Contents/MacOS/launchpad-gen3"
printf '%s\n' "$ROOT" > "$BUILD_APP/Contents/Resources/root-path"

ROOT_ID="$(printf '%s' "$ROOT" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
JOB_LABEL="com.humanandmachine.launchpad-gen3.${ROOT_ID:0:12}"
LOG_DIR="$HOME/Library/Logs/HumanAndMachine"
/usr/libexec/PlistBuddy -c "Set :Label $JOB_LABEL" "$BUILD_APP/Contents/Resources/LaunchAgent.plist"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 $ROOT/Launchpad.command" "$BUILD_APP/Contents/Resources/LaunchAgent.plist"
/usr/libexec/PlistBuddy -c "Set :StandardOutPath $LOG_DIR/launchpad-gen3.log" "$BUILD_APP/Contents/Resources/LaunchAgent.plist"
/usr/libexec/PlistBuddy -c "Set :StandardErrorPath $LOG_DIR/launchpad-gen3.log" "$BUILD_APP/Contents/Resources/LaunchAgent.plist"
printf '%s\n' "$JOB_LABEL" > "$BUILD_APP/Contents/Resources/job-label"

# Při přeinstalaci zachovej současnou vlastní ikonu aplikace. Modulové pixelové
# ikony jsou součástí webového Launchpadu a tento instalátor se jich nedotýká.
if [[ -f "$TARGET/Contents/Resources/applet.icns" ]]; then
  cp "$TARGET/Contents/Resources/applet.icns" "$BUILD_APP/Contents/Resources/applet.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string applet" "$BUILD_APP/Contents/Info.plist"
fi

plutil -lint "$BUILD_APP/Contents/Info.plist" >/dev/null
plutil -lint "$BUILD_APP/Contents/Resources/LaunchAgent.plist" >/dev/null
codesign --force --deep --sign - "$BUILD_APP" >/dev/null
codesign --verify --deep --strict "$BUILD_APP"

if [[ -e "$TARGET" ]]; then
  BACKUP="${TARGET%.app}.backup-$(date +%Y%m%d-%H%M%S).app"
  mv "$TARGET" "$BACKUP"
  echo "Původní launcher zálohován: $BACKUP"
fi

mkdir -p "$(dirname "$TARGET")"
mv "$BUILD_APP" "$TARGET"
echo "Launchpad launcher nainstalován: $TARGET"
