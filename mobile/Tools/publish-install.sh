#!/bin/bash
# Builds, signs and publishes Harness for Mark's devices:
#   - iPhone: Release archive of the prebuilt ios/ workspace (JS bundle embedded, no Metro),
#     exported as a development-signed IPA (method "debugging")
#   - Mac: the Electron app packaged, Developer ID signed with the hardened runtime, notarized
#     when NOTARY_PROFILE names a notarytool keychain profile, zipped with ditto
# A release is controlled by its git tag (CLAUDE.md → Releases): HEAD must be a commit with an
# annotated app-YYYYMMDD.HHMM tag that is pushed and on origin/main, the tree must be clean, and
# CHANGELOG.md must have that tag's section. Both files go to the GitHub release of that tag with
# the section as its notes; the iOS build number is the tag's digits. The install page and the OTA
# manifest.plist (HTTPS, text/xml) are regenerated and deployed to https://harness-install.vercel.app.
# Neither artifact carries a token: pairing provides it.
#
#   mobile/Tools/publish-install.sh [--skip-ios] [--skip-mac] [--no-publish]
#
# --no-publish builds without the tag checks (untagged builds number themselves by the clock).
set -euo pipefail

cd "$(dirname "$0")/.."
MOBILE=$PWD
ROOT=$(cd .. && pwd)
BUNDLE_ID=com.markhuot.harness
TEAM_ID=47P4ZSALX4
SITE=https://harness-install.vercel.app
REPO=markhuot/harness
SKIP_IOS=0; SKIP_MAC=0; PUBLISH=1
for a in "$@"; do
  case "$a" in
    --skip-ios) SKIP_IOS=1 ;;
    --skip-mac) SKIP_MAC=1 ;;
    --no-publish) PUBLISH=0 ;;
  esac
done

# xcode-select points at the Command Line Tools on this Mac; use the full Xcode for this process
# only rather than switching it globally.
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode-27.0.0.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer
fi

# The release tag on HEAD (annotated only: `git describe` without --tags skips lightweight tags).
TAG=$(git -C "$ROOT" describe --exact-match --match 'app-*' HEAD 2>/dev/null || true)
if [[ $PUBLISH -eq 1 ]]; then
  fail() { echo "error: $1" >&2; exit 1; }
  [[ -n "$TAG" ]] || fail "HEAD has no annotated app-* release tag; see CLAUDE.md → Releases (bun run release:prepare, then git tag -a)"
  [[ -z "$(git -C "$ROOT" status --porcelain)" ]] || fail "the working tree has uncommitted changes; a release builds exactly what $TAG points at"
  BUILD_NUMBER=$(bun Tools/release.ts check "$TAG") || exit 1
  REMOTE_COMMIT=$(git -C "$ROOT" ls-remote origin "refs/tags/$TAG^{}" | cut -f1)
  [[ -n "$REMOTE_COMMIT" ]] || fail "$TAG is not on origin; push it first: git push origin main $TAG"
  [[ "$REMOTE_COMMIT" == "$(git -C "$ROOT" rev-parse HEAD)" ]] || fail "origin's $TAG doesn't point at HEAD"
  git -C "$ROOT" fetch --quiet origin main
  git -C "$ROOT" merge-base --is-ancestor HEAD origin/main || fail "$TAG isn't on origin/main yet; merge and push main first"
  ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || fail "GitHub already has a release for $TAG; tag a new release instead of republishing"
  echo "==> Releasing $TAG (build $BUILD_NUMBER, commit $(git -C "$ROOT" rev-parse --short HEAD))"
else
  BUILD_NUMBER=${TAG:+$(bun Tools/release.ts check "$TAG" 2>/dev/null)}
  BUILD_NUMBER=${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
fi
OUT="$MOBILE/build/release"
mkdir -p "$OUT"

# Refuse to publish anything that contains a token we can read (never printed).
check_no_token() {
  local dir=$1 leaked=0 token_file token
  for token_file in "${HARNESS_HOME:+$HARNESS_HOME/token}" "$HOME/.harness/token"; do
    [[ -n "$token_file" && -r "$token_file" ]] || continue
    token=$(tr -d '[:space:]' < "$token_file")
    [[ ${#token} -ge 8 ]] || continue
    if grep -rqF -- "$token" "$dir"; then
      echo "error: $dir contains the token from $token_file; refusing to publish" >&2
      leaked=1
    fi
  done
  return $leaked
}

# ------------------------------------------------------------------ iPhone
if [[ $SKIP_IOS -eq 0 ]]; then
  if [[ ! -d ios/Harness.xcworkspace ]]; then
    echo "==> Generating the native iOS project"
    bunx expo prebuild --platform ios --no-install
    (cd ios && "$MOBILE/Tools/pod.sh" install)
  fi

  echo "==> Archiving (Release, JS bundle embedded, build $BUILD_NUMBER)"
  rm -rf build/Harness.xcarchive
  xcodebuild -workspace ios/Harness.xcworkspace -scheme Harness \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath build/Harness.xcarchive \
    -derivedDataPath build/dd-device \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    archive > build/archive.log 2>&1 || { tail -40 build/archive.log >&2; exit 1; }

  echo "==> Exporting a development-signed IPA"
  rm -rf build/ipa-dev
  xcodebuild -exportArchive \
    -archivePath build/Harness.xcarchive \
    -exportOptionsPlist ExportOptions.plist \
    -exportPath build/ipa-dev \
    -allowProvisioningUpdates > build/export.log 2>&1 || { tail -40 build/export.log >&2; exit 1; }
  IPA=build/ipa-dev/Harness.ipa
  [[ -f "$IPA" ]] || { echo "error: $IPA was not produced" >&2; exit 1; }

  echo "==> Verifying the IPA"
  CHECK=build/ipa-check
  rm -rf "$CHECK"; mkdir -p "$CHECK"
  unzip -q "$IPA" -d "$CHECK"
  APP="$CHECK/Payload/Harness.app"
  [[ -d "$APP" ]] || { echo "error: Payload/Harness.app missing from the IPA" >&2; exit 1; }
  ACTUAL_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")
  [[ "$ACTUAL_ID" == "$BUNDLE_ID" ]] || { echo "error: CFBundleIdentifier is '$ACTUAL_ID', expected '$BUNDLE_ID'" >&2; exit 1; }
  [[ -s "$APP/main.jsbundle" ]] || { echo "error: main.jsbundle is not embedded; this build would try to load from Metro" >&2; exit 1; }
  IOS_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist")
  IOS_BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Info.plist")
  check_no_token "$CHECK"
  rm -rf "$CHECK"
  cp "$IPA" "$OUT/Harness.ipa"
  echo "    $BUNDLE_ID $IOS_VERSION ($IOS_BUILD), main.jsbundle embedded, no token found"
fi

# ------------------------------------------------------------------ Mac
if [[ $SKIP_MAC -eq 0 ]]; then
  echo "==> Packaging the Mac app"
  (cd "$ROOT/app" && bun run package > "$OUT/mac-package.log" 2>&1) || { tail -30 "$OUT/mac-package.log" >&2; exit 1; }
  echo "==> Signing (Developer ID, hardened runtime)${NOTARY_PROFILE:+ and notarizing}"
  (cd "$ROOT/app" && bun scripts/sign-mac.ts --zip "$OUT/Harness-mac.zip") | tee "$OUT/mac-sign.log"
  MAC_NOTARIZED=$(tail -1 "$OUT/mac-sign.log" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).notarized)')
  MAC_VERSION=$(bun -e "console.log(require('$ROOT/app/package.json').version)")
  CHECK=build/mac-check
  rm -rf "$CHECK"; mkdir -p "$CHECK"
  ditto -x -k "$OUT/Harness-mac.zip" "$CHECK"
  check_no_token "$CHECK"
  rm -rf "$CHECK"
fi

[[ $PUBLISH -eq 1 ]] || { echo "Built into $OUT (not published)"; exit 0; }
[[ -f "$OUT/Harness.ipa" && -f "$OUT/Harness-mac.zip" ]] || { echo "error: need both $OUT/Harness.ipa and $OUT/Harness-mac.zip to publish" >&2; exit 1; }

# ------------------------------------------------------------------ GitHub release
echo "==> Creating GitHub release $TAG"
NOTES="$(bun Tools/release.ts notes "$TAG")

---

iPhone: Harness ${IOS_VERSION:-?} (${IOS_BUILD:-?}), development build for registered devices. Install from $SITE
Mac (Apple silicon): Harness ${MAC_VERSION:-?}, Developer ID signed$([[ "${MAC_NOTARIZED:-false}" == true ]] && echo ' and notarized' || echo ', not notarized (System Settings → Privacy & Security → Open Anyway the first time)').
Commit $(git -C "$ROOT" rev-parse --short HEAD)."
# --verify-tag: never let gh invent the tag on the remote's main tip; the release is the pushed tag.
gh release create "$TAG" "$OUT/Harness.ipa" "$OUT/Harness-mac.zip" --repo "$REPO" --verify-tag --title "Harness $TAG" --notes "$NOTES" --latest
IPA_URL="https://github.com/$REPO/releases/latest/download/Harness.ipa"
MAC_URL="https://github.com/$REPO/releases/latest/download/Harness-mac.zip"

echo "==> Checking the release downloads (the OTA installer follows GitHub's redirect)"
for url in "$IPA_URL" "$MAC_URL"; do
  curl -sSIL -o /dev/null -w "    %{http_code}  %{size_download}  %{num_redirects} redirects  %{url_effective}\n" "$url" | sed -E 's/\?.*//'
done
IPA_LEN=$(curl -sSIL "$IPA_URL" | awk 'tolower($1)=="content-length:"{v=$2} END{print v}' | tr -d '\r')
[[ "$IPA_LEN" == "$(stat -f %z "$OUT/Harness.ipa")" ]] || { echo "error: $IPA_URL length $IPA_LEN doesn't match the IPA" >&2; exit 1; }

# ------------------------------------------------------------------ Install page
echo "==> Writing and deploying the install page"
INFO=$(bun -e '
  const [site, tag, repo, ipaUrl, macUrl, iosV, iosB, macV, notarized, ipa, zip] = process.argv.slice(1);
  const fs = require("node:fs");
  console.log(JSON.stringify({
    site, tag, releaseUrl: `https://github.com/${repo}/releases/tag/${tag}`, date: new Date().toISOString().slice(0, 10),
    ios: { url: ipaUrl, version: iosV, build: iosB, bytes: fs.statSync(ipa).size },
    mac: { url: macUrl, version: macV, bytes: fs.statSync(zip).size, notarized: notarized === "true" },
  }));' "$SITE" "$TAG" "$REPO" "$IPA_URL" "$MAC_URL" "${IOS_VERSION:-1.0.0}" "${IOS_BUILD:-$BUILD_NUMBER}" "${MAC_VERSION:-0.0.0}" "${MAC_NOTARIZED:-false}" "$OUT/Harness.ipa" "$OUT/Harness-mac.zip")
bun Tools/install-page.ts "$INFO"
rm -f Install/Harness.ipa
check_no_token Install
(cd Install && vercel deploy --prod --yes >/dev/null)

echo "==> Checking the published site"
for path in / /manifest.plist; do
  curl -sS -o /dev/null -I -w "    %{http_code}  %{content_type}  $path\n" "$SITE$path"
done
echo
echo "Release: https://github.com/$REPO/releases/tag/$TAG"
echo "Install from: $SITE"
echo "Commit the regenerated install page on main: git add mobile/Install && git commit -m \"Install page: release $TAG\""
