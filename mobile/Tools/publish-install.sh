#!/bin/bash
# Rebuilds the iPhone build and republishes the install page at
# https://harness-install.vercel.app. Runs from anywhere; it works inside mobile/.
set -euo pipefail

cd "$(dirname "$0")/.."

BUNDLE_ID=com.markhuot.harness
TEAM_ID=47P4ZSALX4
SITE=https://harness-install.vercel.app

# xcode-select points at the Command Line Tools on this Mac; use the full Xcode
# for this process only rather than switching it globally.
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode-27.0.0.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer
fi

if [[ ! -d ios ]]; then
  echo "==> Generating the native iOS project"
  bunx expo prebuild --platform ios --no-install
  (cd ios && pod install)
fi

echo "==> Archiving (Release, JS bundle embedded)"
rm -rf build/Harness.xcarchive
xcodebuild -workspace ios/Harness.xcworkspace -scheme Harness \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/Harness.xcarchive \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
  archive

echo "==> Exporting a development-signed IPA"
rm -rf build/ipa-dev
xcodebuild -exportArchive \
  -archivePath build/Harness.xcarchive \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath build/ipa-dev \
  -allowProvisioningUpdates

IPA=build/ipa-dev/Harness.ipa
if [[ ! -f "$IPA" ]]; then
  echo "error: $IPA was not produced" >&2
  ls -la build/ipa-dev >&2 || true
  exit 1
fi

echo "==> Verifying the IPA"
CHECK=build/ipa-check
rm -rf "$CHECK"
mkdir -p "$CHECK"
unzip -q "$IPA" -d "$CHECK"
APP="$CHECK/Payload/Harness.app"
if [[ ! -d "$APP" ]]; then
  echo "error: Payload/Harness.app missing from the IPA" >&2
  exit 1
fi

ACTUAL_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")
if [[ "$ACTUAL_ID" != "$BUNDLE_ID" ]]; then
  echo "error: CFBundleIdentifier is '$ACTUAL_ID', expected '$BUNDLE_ID'" >&2
  exit 1
fi

if [[ ! -s "$APP/main.jsbundle" ]]; then
  echo "error: main.jsbundle is not embedded; this build would try to load from Metro" >&2
  exit 1
fi

# The IPA is served publicly, so it must not carry the service token. Compare
# against every token file we can read without ever printing its contents.
leaked=0
for token_file in "${HARNESS_HOME:+$HARNESS_HOME/token}" "$HOME/.harness/token"; do
  [[ -n "$token_file" && -r "$token_file" ]] || continue
  token=$(tr -d '[:space:]' < "$token_file")
  [[ ${#token} -ge 8 ]] || continue
  if grep -rqF -- "$token" "$CHECK"; then
    echo "error: the IPA contains the token from $token_file; refusing to publish" >&2
    leaked=1
  fi
done
unset token
rm -rf "$CHECK"
if [[ $leaked -ne 0 ]]; then
  exit 1
fi
echo "    $BUNDLE_ID, main.jsbundle embedded, no token found"

echo "==> Publishing"
cp "$IPA" Install/Harness.ipa
(cd Install && vercel deploy --prod --yes >/dev/null)

echo "==> Checking the published site"
for path in / /manifest.plist /Harness.ipa; do
  curl -sS -o /dev/null -I -w "    %{http_code}  %{content_type}  $path\n" "$SITE$path"
done

echo
echo "Install from: $SITE"
echo "Open that on the iPhone in Safari and tap Install Harness."
