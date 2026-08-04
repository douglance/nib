#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORTAL_ROOT="$ROOT/apps/portal"
CLOUDFLARE_ROOT="$ROOT/apps/cloudflare"
CODEMODE_ROOT="$ROOT/apps/cloudflare-codemode"
BIN_DIR="${NIB_BIN_DIR:-/opt/homebrew/bin}"
PORTAL_URL="${NIB_PORTAL_URL:-https://nib-global.doug-lance.workers.dev}"
PORTAL_HEALTH_URL="${NIB_PORTAL_HEALTH_URL:-$PORTAL_URL/api/health}"
CODEMODE_HEALTH_URL="${NIB_CODEMODE_HEALTH_URL:-https://nib-codemode-global.doug-lance.workers.dev/health}"
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

for command in cargo codesign curl install jq npm xcodebuild xcodegen xcrun; do
  require_command "$command"
done

echo "Building global Nib binaries..."
cd "$ROOT"
cargo build --release --all-features --bins
install -d "$BIN_DIR"
install -m 0755 "$ROOT/target/release/nib" "$BIN_DIR/nib"

echo "Syncing Nib skills to shared agent roots..."
"$BIN_DIR/nib" skills add
mkdir -p "$HOME/.agents/skills" "$HOME/.codex/skills" "$HOME/.claude/skills"
ln -sfn "$ROOT/skills/nib" "$HOME/.agents/skills/nib"
ln -sfn ../../.agents/skills/nib "$HOME/.codex/skills/nib"
ln -sfn ../../.agents/skills/nib "$HOME/.claude/skills/nib"

echo "Verifying the local portal package..."
npm --prefix "$PORTAL_ROOT" ci
npm --prefix "$PORTAL_ROOT" run verify

echo "Deploying the global Cloudflare request service..."
npm --prefix "$CLOUDFLARE_ROOT" ci
npm --prefix "$CLOUDFLARE_ROOT" run check
npm --prefix "$CLOUDFLARE_ROOT" audit --omit=dev
npm --prefix "$CLOUDFLARE_ROOT" run deploy

echo "Enrolling and verifying the standard Nib CLI..."
"$BIN_DIR/nib" auth login --portal "$PORTAL_URL"
"$BIN_DIR/nib" auth status --portal "$PORTAL_URL" --format json >/dev/null

echo "Deploying the global Incurs Code Mode service..."
npm --prefix "$CODEMODE_ROOT" ci
npm --prefix "$CODEMODE_ROOT" run check
codemode_credential="$("$BIN_DIR/nib" auth issue \
  --portal "$PORTAL_URL" \
  --name "Global Code Mode" \
  --platform cloudflare-codemode \
  --format json)"
codemode_token="$(printf '%s' "$codemode_credential" | jq -er .token)"
printf '%s' "$codemode_token" | (cd "$CODEMODE_ROOT" && npx wrangler secret put NIB_AUTH_TOKEN)
unset codemode_credential codemode_token
npm --prefix "$CODEMODE_ROOT" run deploy

echo "Building the signed iPhone and Watch apps..."
xcodegen generate \
  --spec "$PORTAL_ROOT/mobile/Nib/project.yml" \
  --project "$PORTAL_ROOT/mobile/Nib"
derived_data="$(mktemp -d /tmp/nib-ship-ios.XXXXXX)"
xcodebuild \
  -project "$PORTAL_ROOT/mobile/Nib/Nib.xcodeproj" \
  -scheme Nib \
  -destination "id=$IOS_DESTINATION_ID" \
  -derivedDataPath "$derived_data" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  build

app_path="$derived_data/Build/Products/Debug-iphoneos/Nib.app"
xcrun devicectl device install app --device "$IOS_DEVICE_ID" "$app_path"
ios_pairing="$("$BIN_DIR/nib" auth pair --portal "$PORTAL_URL" --format json | jq -er .code)"
xcrun devicectl device process launch \
  --device "$IOS_DEVICE_ID" \
  --terminate-existing \
  com.douglance.nib \
  -- \
  -nib.server "$PORTAL_URL" \
  -nib.pairingCode "$ios_pairing"
unset ios_pairing

watch_app_path="$derived_data/Build/Products/Debug-watchos/NibWatch.app"
if ! xcrun devicectl device install app --device "$WATCH_DEVICE_ID" "$watch_app_path"; then
  echo "Watch was not directly reachable; its signed companion remains embedded in the installed iPhone app." >&2
else
  watch_pairing="$("$BIN_DIR/nib" auth pair --portal "$PORTAL_URL" --format json | jq -er .code)"
  if ! xcrun devicectl device process launch \
    --device "$WATCH_DEVICE_ID" \
    --terminate-existing \
    com.douglance.nib.watchkitapp \
    -- \
    -nib.server "$PORTAL_URL" \
    -nib.pairingCode "$watch_pairing"; then
    echo "Watch app installed, but the paired Watch was not reachable for launch." >&2
  fi
  unset watch_pairing
fi

echo "Building and installing the Vision Pro app..."
vision_derived_data="$(mktemp -d /tmp/nib-ship-vision.XXXXXX)"
xcodebuild \
  -project "$PORTAL_ROOT/mobile/Nib/Nib.xcodeproj" \
  -scheme NibVision \
  -destination "generic/platform=visionOS" \
  -derivedDataPath "$vision_derived_data" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  build
vision_app_path="$vision_derived_data/Build/Products/Debug-xros/NibVision.app"
xcrun devicectl device install app --device "$VISION_DEVICE_ID" "$vision_app_path"
vision_pairing="$("$BIN_DIR/nib" auth pair --portal "$PORTAL_URL" --format json | jq -er .code)"
if ! xcrun devicectl device process launch \
  --device "$VISION_DEVICE_ID" \
  --terminate-existing \
  --timeout 20 \
  com.douglance.nib \
  -- \
  -nib.server "$PORTAL_URL" \
  -nib.pairingCode "$vision_pairing"; then
  echo "Vision Pro app installed, but the headset must be awake and unlocked for remote launch." >&2
fi
unset vision_pairing

echo "Building and installing the macOS menu-bar app..."
mac_derived_data="$(mktemp -d /tmp/nib-ship-macos.XXXXXX)"
xcodebuild \
  -project "$PORTAL_ROOT/mobile/Nib/Nib.xcodeproj" \
  -scheme NibMac \
  -destination "platform=macOS,arch=$(uname -m)" \
  -derivedDataPath "$mac_derived_data" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  NIB_REVIEWER_BINARY="$ROOT/target/release/nib" \
  build
install -d "$MAC_APP_DIR"
mac_app_path="$mac_derived_data/Build/Products/Debug/Nib.app"
reviewer_path="$mac_app_path/Contents/Helpers/nib-reviewer"
test -x "$reviewer_path"
"$reviewer_path" --version
codesign --verify --deep --strict "$mac_app_path"
ditto "$mac_app_path" "$MAC_APP_DIR/Nib.app"
defaults write com.douglance.nib.macos nib.baseURL "https://nib-global.doug-lance.workers.dev"
open "$MAC_APP_DIR/Nib.app"

echo "Verifying installed surfaces..."
"$BIN_DIR/nib" --version
curl -fsS "$PORTAL_HEALTH_URL" >/dev/null
curl -fsS "$CODEMODE_HEALTH_URL" >/dev/null
"$BIN_DIR/nib" auth status --portal "$PORTAL_URL" --format json >/dev/null

echo "Nib is installed globally, Cloudflare is live, and the latest Mac, iPhone, Watch, and Vision Pro apps are installed."
