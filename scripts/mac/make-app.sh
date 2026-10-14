#!/usr/bin/env bash
# Builds Switchyard.app into ~/Applications or $1.
# With swiftc (Xcode Command Line Tools) it is a native AppKit + WebKit window (scripts/mac/SwitchyardApp.swift);
# without it, a bash launcher that opens the UI in the default browser. Both start the server if it is down.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/Switchyard.app"
SWIFTC="$(command -v swiftc || true)"
MODE=bash
[ -n "$SWIFTC" ] && "$SWIFTC" --version >/dev/null 2>&1 && MODE=swift
SY_HOME="${SWITCHYARD_HOME:-$HOME/.switchyard}"
mkdir -p "$SY_HOME"
# Keep the previous build as $SY_HOME/Switchyard.app.bak (one generation) so a bad rebuild is a `mv` away.
if [ -d "$APP" ]; then rm -rf "$SY_HOME/Switchyard.app.bak"; mv "$APP" "$SY_HOME/Switchyard.app.bak"; fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [ "$MODE" = swift ]; then
  EXE=Switchyard
  BUNDLE_ID=local.switchyard.app
  EXTRA='  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.3</string>
  <key>NSMicrophoneUsageDescription</key><string>Switchyard uses the microphone for voice input in the UI.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Switchyard turns speech into text for voice input.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>'
  # Icon: rasterize the web logo with Quick Look, then iconutil. Optional — a missing icon is not an error.
  ICONSET="$(mktemp -d)/Switchyard.iconset"
  mkdir -p "$ICONSET"
  if qlmanage -t -s 1024 -o "$ICONSET" "$REPO/packages/web/public/favicon.svg" >/dev/null 2>&1 \
    && [ -f "$ICONSET/favicon.svg.png" ]; then
    for s in 16 32 128 256 512; do
      sips -z $s $s "$ICONSET/favicon.svg.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
      sips -z $((s * 2)) $((s * 2)) "$ICONSET/favicon.svg.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
    done
    rm "$ICONSET/favicon.svg.png"
    if iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Switchyard.icns" 2>/dev/null; then
      EXTRA="$EXTRA
  <key>CFBundleIconFile</key><string>Switchyard</string>"
    fi
  fi
  rm -rf "$(dirname "$ICONSET")"
else
  EXE=launcher
  BUNDLE_ID=local.switchyard.launcher
  EXTRA='  <key>LSUIElement</key><true/>'
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Switchyard</string>
  <key>CFBundleDisplayName</key><string>Switchyard</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>$EXE</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
$EXTRA
</dict></plist>
PLIST

if [ "$MODE" = swift ]; then
  SRC="$(mktemp -d)/SwitchyardApp.swift"
  # Bake the repo path in (the app has no cwd when launched from the Dock).
  grep -q '"@@REPO@@"' "$REPO/scripts/mac/SwitchyardApp.swift"
  sed "s|@@REPO@@|$REPO|" "$REPO/scripts/mac/SwitchyardApp.swift" > "$SRC"
  "$SWIFTC" -O -parse-as-library -framework Cocoa -framework WebKit -o "$APP/Contents/MacOS/$EXE" "$SRC"
  rm -rf "$(dirname "$SRC")"
  # Ad-hoc signature: a stable identity so TCC (microphone) and Gatekeeper treat rebuilds as the same app.
  codesign --force --deep --sign - "$APP" 2>/dev/null
else
  cat > "$APP/Contents/MacOS/$EXE" <<LAUNCH
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
  chmod +x "$APP/Contents/MacOS/$EXE"
fi

# Diagnostics (no secrets): which repo the app points at and how it was built.
printf '{"repo":"%s","builtAt":"%s","mode":"%s"}\n' "$REPO" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" > "$SY_HOME/mac-app.json"

echo "Built $APP ($MODE) — double-click it, or drag it to the Dock."
