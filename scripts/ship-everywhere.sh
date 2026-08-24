#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPLE_ROOT="$ROOT/apps/portal/mobile/Nib"
REVIEW_CLOUD_ROOT="$ROOT/apps/cloudflare"
PRODUCT_CLOUD_ROOT="$ROOT/apps/web"
CODEMODE_ROOT="$ROOT/apps/cloudflare-codemode"
BIN_DIR="${NIB_BIN_DIR:-/opt/homebrew/bin}"
IOS_DESTINATION_ID="${NIB_IOS_DESTINATION_ID:-00008150-00161D440138401C}"
IOS_DEVICE_ID="${NIB_IOS_DEVICE_ID:-6BFFDE03-31AD-5B12-9E16-984017D96B70}"
WATCH_DEVICE_ID="${NIB_WATCH_DEVICE_ID:-6E84D0B3-AD0E-5178-92FD-15851762F26B}"
VISION_DEVICE_ID="${NIB_VISION_DEVICE_ID:-E74BBABA-4B8F-5A41-AC2E-8DC0BBCDF8DF}"
APPLE_TEAM_ID="${NIB_APPLE_TEAM_ID:-2AS3V73632}"
MAC_APP_DIR="${NIB_MAC_APP_DIR:-/Applications}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

for command in cargo codesign curl install npm xcodebuild xcodegen xcrun; do
  require_command "$command"
done

echo "Building and installing the Nib CLI..."
cd "$ROOT"
cargo build --release --all-features --bins
install -d "$BIN_DIR"
install -m 0755 "$ROOT/target/release/nib" "$BIN_DIR/nib"

echo "Syncing Nib skills..."
"$BIN_DIR/nib" skills add
mkdir -p "$HOME/.agents/skills" "$HOME/.codex/skills" "$HOME/.claude/skills"
ln -sfn "$ROOT/skills/nib" "$HOME/.agents/skills/nib"
ln -sfn ../../.agents/skills/nib "$HOME/.codex/skills/nib"
ln -sfn ../../.agents/skills/nib "$HOME/.claude/skills/nib"

echo "Deploying Nib Cloud..."
npm --prefix "$REVIEW_CLOUD_ROOT" ci
npm --prefix "$REVIEW_CLOUD_ROOT" test
npm --prefix "$REVIEW_CLOUD_ROOT" run check
npm --prefix "$REVIEW_CLOUD_ROOT" run deploy
npm --prefix "$PRODUCT_CLOUD_ROOT" ci
npm --prefix "$PRODUCT_CLOUD_ROOT" test
npm --prefix "$PRODUCT_CLOUD_ROOT" run check
npm --prefix "$PRODUCT_CLOUD_ROOT" run deploy

echo "Deploying the Nib Code Mode service..."
npm --prefix "$CODEMODE_ROOT" ci
npm --prefix "$CODEMODE_ROOT" run check
npm --prefix "$CODEMODE_ROOT" run deploy

echo "Building the Apple apps..."
xcodegen generate --spec "$APPLE_ROOT/project.yml" --project "$APPLE_ROOT"
ios_derived_data="$(mktemp -d /tmp/nib-ship-ios.XXXXXX)"
xcodebuild \
  -project "$APPLE_ROOT/Nib.xcodeproj" \
  -scheme Nib \
  -destination "id=$IOS_DESTINATION_ID" \
  -derivedDataPath "$ios_derived_data" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  build

ios_app_path="$ios_derived_data/Build/Products/Debug-iphoneos/Nib.app"
xcrun devicectl device install app --device "$IOS_DEVICE_ID" "$ios_app_path"
xcrun devicectl device process launch \
  --device "$IOS_DEVICE_ID" \
  --terminate-existing \
  com.douglance.nib

watch_app_path="$ios_derived_data/Build/Products/Debug-watchos/NibWatch.app"
if xcrun devicectl device install app --device "$WATCH_DEVICE_ID" "$watch_app_path"; then
  xcrun devicectl device process launch \
    --device "$WATCH_DEVICE_ID" \
    --terminate-existing \
    com.douglance.nib.watchkitapp || true
fi

vision_derived_data="$(mktemp -d /tmp/nib-ship-vision.XXXXXX)"
xcodebuild \
  -project "$APPLE_ROOT/Nib.xcodeproj" \
  -scheme NibVision \
  -destination "generic/platform=visionOS" \
  -derivedDataPath "$vision_derived_data" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  build
vision_app_path="$vision_derived_data/Build/Products/Debug-xros/NibVision.app"
xcrun devicectl device install app --device "$VISION_DEVICE_ID" "$vision_app_path"
xcrun devicectl device process launch \
  --device "$VISION_DEVICE_ID" \
  --terminate-existing \
  --timeout 20 \
  com.douglance.nib || true

mac_derived_data="$(mktemp -d /tmp/nib-ship-macos.XXXXXX)"
xcodebuild \
  -project "$APPLE_ROOT/Nib.xcodeproj" \
  -scheme NibMac \
  -destination "platform=macOS,arch=$(uname -m)" \
  -derivedDataPath "$mac_derived_data" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  build
mac_app_path="$mac_derived_data/Build/Products/Debug/Nib.app"
codesign --verify --deep --strict "$mac_app_path"
install -d "$MAC_APP_DIR"
ditto "$mac_app_path" "$MAC_APP_DIR/Nib.app"
open "$MAC_APP_DIR/Nib.app"

echo "Verifying the fixed production origin..."
"$BIN_DIR/nib" --version
curl -fsS https://nibtool.com/health >/dev/null

echo "Nib Cloud and all Apple clients are shipped."
