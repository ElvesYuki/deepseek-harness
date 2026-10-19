#!/bin/bash
# Per-user installation: keep mutable DSH files outside the application bundle.
set -euo pipefail
trap 'echo "Installation failed. Close DSH Launcher and retry; retain launcher.log in the application data directory."; read -r -p "Press Return to close. "' ERR
SOURCE="$(cd "$(dirname "$0")" && pwd)/DSH Launcher.app"
TARGET="$HOME/Applications/DSH Launcher.app"
if [ ! -d "$SOURCE" ]; then
  echo "Run this command from the mounted DSH Launcher DMG."
  exit 1
fi
# Honor an exact application already dragged into /Applications.
if [ -d "/Applications/DSH Launcher.app" ]; then
  TARGET="/Applications/DSH Launcher.app"
fi
if [ -e "$TARGET" ]; then
  if ! cmp -s "$SOURCE/Contents/Resources/app.asar" "$TARGET/Contents/Resources/app.asar" ||
     ! cmp -s "$SOURCE/Contents/Resources/payload/manifest.json" "$TARGET/Contents/Resources/payload/manifest.json"; then
    echo "A different launcher is installed at $TARGET. Quit it, replace it with the app from this DMG, then rerun this command. User data stays separate."
    read -r -p "Press Return to close. "
    exit 1
  fi
else
  mkdir -p "$HOME/Applications"
  STAGING="$(mktemp -d "$HOME/Applications/.dsh-install.XXXXXX")"
  trap 'rm -rf "$STAGING"' EXIT
  echo "Installing application in $TARGET..."
  ditto "$SOURCE" "$STAGING/DSH Launcher.app"
  mv "$STAGING/DSH Launcher.app" "$TARGET"
fi
echo "Preparing the fixed runtime. Do not open the launcher until this finishes..."
"$TARGET/Contents/MacOS/DSH Launcher" --install-runtime
echo "Installation complete. You can now open $TARGET."
read -r -p "Press Return to close. "
