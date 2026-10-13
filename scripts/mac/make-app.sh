#!/usr/bin/env bash
# Builds a tiny Switchyard.app (a bash launcher, no Electron) into ~/Applications or $1.
# The app starts the local server if needed and opens the UI in your browser. Menu-bar-less (LSUIElement).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/Switchyard.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Switchyard</string>
  <key>CFBundleIdentifier</key><string>local.switchyard.launcher</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

cat > "$APP/Contents/MacOS/launcher" <<LAUNCH
#!/usr/bin/env bash
REPO="$REPO"
HOME_DIR="\${SWITCHYARD_HOME:-\$HOME/.switchyard}"
PORT="\${SWITCHYARD_PORT:-4777}"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH"
mkdir -p "\$HOME_DIR"
up() { curl -fs -o /dev/null "http://127.0.0.1:\$PORT/" 2>/dev/null; }
if ! up; then
  cd "\$REPO" || exit 1
  [ -f packages/core/dist/server.js ] || npm run build >> "\$HOME_DIR/server.log" 2>&1
  nohup node --max-semi-space-size=1 packages/core/dist/server.js >> "\$HOME_DIR/server.log" 2>&1 &
  for _ in \$(seq 1 60); do up && break; sleep 0.5; done
fi
TOKEN=""
[ -f "\$HOME_DIR/ui-session" ] && TOKEN="\$(tr -d '\n' < "\$HOME_DIR/ui-session")"
open "http://127.0.0.1:\$PORT/#token=\$TOKEN"
LAUNCH
chmod +x "$APP/Contents/MacOS/launcher"
echo "Built $APP — double-click it, or drag it to the Dock."
