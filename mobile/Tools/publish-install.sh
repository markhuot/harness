#!/bin/bash
# Builds, signs and publishes Harness for Mark's devices:
#   - iPhone and iPad (one universal app): Release archive of the prebuilt ios/ workspace (JS bundle embedded, no Metro),
#     exported as a development-signed IPA (method "debugging")
#   - Mac: the Electron app packaged, Developer ID signed with the hardened runtime, notarized
#     with the App Store Connect API key when publishing (or the notarytool keychain profile
#     NOTARY_PROFILE when that's set; a --no-publish build notarizes only then), zipped with ditto
# A release is controlled by its git tag (CLAUDE.md → Releases): HEAD must be a commit with an
# annotated app-YYYYMMDD.HHMM tag that is pushed and on origin/main, the tree must be clean, and
# CHANGELOG.md must have that tag's section. Both files go to the GitHub release of that tag with
# the section as its notes; the iOS build number is the tag's digits. The install page and the OTA
# manifest.plist (HTTPS, text/xml) are regenerated and deployed to https://harness-install.vercel.app.
# Neither artifact carries a token: pairing provides it.
# A published release also goes to TestFlight: the same archive is exported for App Store Connect
# and uploaded (ExportOptions-testflight.plist, signed in with the ASC API key), then
# Tools/testflight.ts adds it to the external "Public" group, submits it for Beta App Review and
# hands the group's public link to the install page. That step needs ASC_KEY_ID and ASC_ISSUER_ID
# (see Tools/testflight.ts); --skip-testflight leaves TestFlight alone.
#
#   mobile/Tools/publish-install.sh [--ios-app=rn|native] [--skip-ios] [--skip-mac] [--skip-testflight] [--no-publish]
#
# --ios-app picks which iPhone/iPad app is built: rn (the default) is this React Native app;
# native is the SwiftUI app in ios/, archived and exported by ios/Tools/build.ts with the same bundle
# id, so it replaces the RN app on devices and TestFlight. Everything after the IPA is the same.
# --no-publish builds without the tag checks (untagged builds number themselves by the clock) and
# never uploads to TestFlight.
set -euo pipefail

cd "$(dirname "$0")/.."
MOBILE=$PWD
ROOT=$(cd .. && pwd)
BUNDLE_ID=com.markhuot.harness
TEAM_ID=47P4ZSALX4
SITE=https://harness-install.vercel.app
REPO=markhuot/harness
VERCEL_PROJECT=harness-install
SKIP_IOS=0; SKIP_MAC=0; SKIP_TESTFLIGHT=0; PUBLISH=1; IOS_APP=rn
for a in "$@"; do
  case "$a" in
    --ios-app=rn|--ios-app=native) IOS_APP=${a#--ios-app=} ;;
    --ios-app*) echo "error: --ios-app must be rn or native, got '${a#--ios-app}'" >&2; exit 2 ;;
    --skip-ios) SKIP_IOS=1 ;;
    --skip-mac) SKIP_MAC=1 ;;
    --skip-testflight) SKIP_TESTFLIGHT=1 ;;
    --no-publish) PUBLISH=0 ;;
    *) echo "error: unknown option $a" >&2; exit 2 ;;
  esac
done
TESTFLIGHT=0
[[ $PUBLISH -eq 1 && $SKIP_IOS -eq 0 && $SKIP_TESTFLIGHT -eq 0 ]] && TESTFLIGHT=1

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
  # A published Mac app is notarized, so anyone who downloads it can open it without Open Anyway.
  # The App Store Connect API key does it unless NOTARY_PROFILE names a keychain profile: a keychain
  # profile can't be read or saved from a background session ("User interaction is not allowed").
  if [[ $SKIP_MAC -eq 0 && -z "${NOTARY_PROFILE:-}" ]]; then
    [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]] || fail "notarizing the Mac app needs ASC_KEY_ID and ASC_ISSUER_ID (or NOTARY_PROFILE)"
    export NOTARIZE_WITH_ASC_KEY=1
  fi
  echo "==> Releasing $TAG (build $BUILD_NUMBER, commit $(git -C "$ROOT" rev-parse --short HEAD))"
else
  BUILD_NUMBER=${TAG:+$(bun Tools/release.ts check "$TAG" 2>/dev/null)}
  BUILD_NUMBER=${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
fi
OUT="$MOBILE/build/release"
mkdir -p "$OUT"

# Check App Store Connect access (API key, app record, public group) before spending time on builds.
if [[ $TESTFLIGHT -eq 1 ]]; then
  echo "==> Checking App Store Connect access for TestFlight"
  TESTFLIGHT_URL=$(bun Tools/testflight.ts link) || { echo "error: can't reach App Store Connect for TestFlight (see above), or pass --skip-testflight" >&2; exit 1; }
  echo "    public link: ${TESTFLIGHT_URL:-none yet, created on distribute}"
fi

# Install/.vercel is gitignored, so a fresh checkout or worktree isn't linked; unlinked, `vercel
# deploy` tries to create a new project. Link the existing one now, before spending time on builds.
if [[ $PUBLISH -eq 1 && ! -f Install/.vercel/project.json ]]; then
  echo "==> Linking Install/ to the Vercel project $VERCEL_PROJECT"
  (cd Install && vercel link --yes --project "$VERCEL_PROJECT" >/dev/null) || { echo "error: couldn't link Install/ to $VERCEL_PROJECT" >&2; exit 1; }
  rm -f Install/.env.local # `vercel link` pulls the project's env vars; the page needs none
fi

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
if [[ $SKIP_IOS -eq 0 && $IOS_APP == native ]]; then
  # The SwiftUI app: build.ts regenerates ios/Harness.xcodeproj (XcodeGen) and logs to ios/build/*.log.
  NATIVE_BUILD=(bun "$ROOT/ios/Tools/build.ts")
  echo "==> Building the native iOS app (ios/, build $BUILD_NUMBER)"
  ARCHIVE=$("${NATIVE_BUILD[@]}" archive --build-number "$BUILD_NUMBER") || exit 1
  IPA=$("${NATIVE_BUILD[@]}" export --method dev --archive-path "$ARCHIVE") || exit 1
elif [[ $SKIP_IOS -eq 0 ]]; then
  # ios/ is gitignored and outlives the commits that change native dependencies, so regenerate it
  # from app.json and package.json on every build, never only when it's missing: an ios/ from before
  # expo-video still archived, and the app aborted on "Cannot find native module 'ExpoVideo'".
  echo "==> Syncing the native iOS project (expo prebuild, pod install)"
  EXPO_NO_GIT_STATUS=1 bunx expo prebuild --platform ios --no-install > build/prebuild.log 2>&1 || { tail -40 build/prebuild.log >&2; exit 1; }
  (cd ios && "$MOBILE/Tools/pod.sh" install) > build/pod-install.log 2>&1 || { tail -40 build/pod-install.log >&2; exit 1; }
  bun Tools/nativeDeps.ts check

  # Prebuild writes a literal CFBundleVersion ("1"), which CURRENT_PROJECT_VERSION can't override;
  # point it at the build setting so the archive carries the tag's digits.
  /usr/libexec/PlistBuddy -c 'Set :CFBundleVersion $(CURRENT_PROJECT_VERSION)' ios/Harness/Info.plist

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
  ARCHIVE=build/Harness.xcarchive
  IPA=build/ipa-dev/Harness.ipa
  [[ -f "$IPA" ]] || { echo "error: $IPA was not produced" >&2; exit 1; }
fi

if [[ $SKIP_IOS -eq 0 ]]; then
  # ios/Tools/build.ts verify checks the bundle id, CFBundleVersion and an arm64 executable, plus, for
  # rn, an embedded main.jsbundle (no Metro) or, for native, a SwiftUI binary with no RN bundle or frameworks.
  echo "==> Verifying the IPA"
  CHECK=build/ipa-check
  rm -rf "$CHECK"; mkdir -p "$CHECK"
  unzip -q "$IPA" -d "$CHECK"
  APP="$CHECK/Payload/Harness.app"
  [[ -d "$APP" ]] || { echo "error: Payload/Harness.app missing from the IPA" >&2; exit 1; }
  VERIFIED=$(bun "$ROOT/ios/Tools/build.ts" verify --kind "$IOS_APP" --bundle-id "$BUNDLE_ID" --build-number "$BUILD_NUMBER" "$APP") || exit 1
  IOS_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist")
  IOS_BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Info.plist")
  check_no_token "$CHECK"
  rm -rf "$CHECK"
  cp "$IPA" "$OUT/Harness.ipa"
  echo "    $VERIFIED, no token found"

  if [[ $TESTFLIGHT -eq 1 ]]; then
    # A rerun of a publish that failed later on finds the build already uploaded; build numbers can't be reused.
    if bun Tools/testflight.ts uploaded "$BUILD_NUMBER"; then
      echo "==> TestFlight already has build $BUILD_NUMBER; not uploading again"
    elif [[ $IOS_APP == native ]]; then
      echo "==> Uploading build $BUILD_NUMBER to App Store Connect (TestFlight)"
      bun "$ROOT/ios/Tools/build.ts" export --method testflight --archive-path "$ARCHIVE" >/dev/null || exit 1
    else
      echo "==> Uploading build $BUILD_NUMBER to App Store Connect (TestFlight)"
      # Sign in with the same API key testflight.ts uses, not the Apple account in Xcode's settings,
      # whose keychain token expires ("Failed to Use Accounts ... missing Xcode-Token").
      xcodebuild -exportArchive \
        -archivePath "$ARCHIVE" \
        -exportOptionsPlist ExportOptions-testflight.plist \
        -exportPath build/ipa-testflight \
        -authenticationKeyPath "${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}" \
        -authenticationKeyID "$ASC_KEY_ID" \
        -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
        -allowProvisioningUpdates > build/upload.log 2>&1 || { tail -40 build/upload.log >&2; exit 1; }
    fi
    echo "==> Distributing to the TestFlight public group (waits for App Store Connect to process the build)"
    TF_JSON=$(TESTFLIGHT_WHATS_NEW="$(bun Tools/release.ts notes "$TAG")" bun Tools/testflight.ts distribute "$BUILD_NUMBER")
    TESTFLIGHT_URL=$(bun -e 'console.log(JSON.parse(process.argv[1]).publicLink ?? "")' "$TF_JSON")
    echo "    $TF_JSON"
    [[ -n "$TESTFLIGHT_URL" ]] || { echo "error: the TestFlight group has no public link" >&2; exit 1; }
  fi
fi

# ------------------------------------------------------------------ Mac
if [[ $SKIP_MAC -eq 0 ]]; then
  echo "==> Packaging the Mac app"
  (cd "$ROOT/app" && bun run package > "$OUT/mac-package.log" 2>&1) || { tail -30 "$OUT/mac-package.log" >&2; exit 1; }
  echo "==> Signing (Developer ID, hardened runtime)${NOTARY_PROFILE:+ and notarizing}${NOTARIZE_WITH_ASC_KEY:+ and notarizing}"
  (cd "$ROOT/app" && bun scripts/sign-mac.ts --zip "$OUT/Harness-mac.zip") | tee "$OUT/mac-sign.log"
  MAC_NOTARIZED=$(tail -1 "$OUT/mac-sign.log" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).notarized)')
  [[ $PUBLISH -eq 0 || "$MAC_NOTARIZED" == true ]] || { echo "error: the Mac app isn't notarized; a published build must be" >&2; exit 1; }
  MAC_VERSION=$(bun -e "console.log(require('$ROOT/app/package.json').version)")
  CHECK=build/mac-check
  rm -rf "$CHECK"; mkdir -p "$CHECK"
  ditto -x -k "$OUT/Harness-mac.zip" "$CHECK"
  check_no_token "$CHECK"
  # The download has to carry its own service (no bun or checkout on the Mac that runs it).
  MAC_CONTENTS="$CHECK/Harness.app/Contents"
  [[ -x "$MAC_CONTENTS/MacOS/harness-service" && -f "$MAC_CONTENTS/Resources/plugins/git/plugin.json" ]] \
    || { echo "error: the Mac app doesn't contain the compiled service and its plugins" >&2; exit 1; }
  grep -q '"executable": "harness-service"' "$MAC_CONTENTS/Resources/app.asar" \
    || { echo "error: the Mac app's harness.json doesn't point at the bundled service" >&2; exit 1; }
  rm -rf "$CHECK"
fi

[[ $PUBLISH -eq 1 ]] || { echo "Built into $OUT (not published)"; exit 0; }
[[ -f "$OUT/Harness.ipa" && -f "$OUT/Harness-mac.zip" ]] || { echo "error: need both $OUT/Harness.ipa and $OUT/Harness-mac.zip to publish" >&2; exit 1; }

# ------------------------------------------------------------------ GitHub release
echo "==> Creating GitHub release $TAG"
NOTES="$(bun Tools/release.ts notes "$TAG")

---

iPhone and iPad: Harness ${IOS_VERSION:-?} (${IOS_BUILD:-?}), $([[ -n "${TESTFLIGHT_URL:-}" ]] && echo "on TestFlight: $TESTFLIGHT_URL (a development build for registered devices is attached too)" || echo "development build for registered devices"). Install from $SITE
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
  const [site, tag, repo, ipaUrl, macUrl, iosV, iosB, macV, notarized, ipa, zip, testflightUrl] = process.argv.slice(1);
  const fs = require("node:fs");
  console.log(JSON.stringify({
    site, tag, releaseUrl: `https://github.com/${repo}/releases/tag/${tag}`, date: new Date().toISOString().slice(0, 10),
    ios: { url: ipaUrl, version: iosV, build: iosB, bytes: fs.statSync(ipa).size, testflightUrl: testflightUrl || null },
    mac: { url: macUrl, version: macV, bytes: fs.statSync(zip).size, notarized: notarized === "true" },
  }));' "$SITE" "$TAG" "$REPO" "$IPA_URL" "$MAC_URL" "${IOS_VERSION:-1.0.0}" "${IOS_BUILD:-$BUILD_NUMBER}" "${MAC_VERSION:-0.0.0}" "${MAC_NOTARIZED:-false}" "$OUT/Harness.ipa" "$OUT/Harness-mac.zip" "${TESTFLIGHT_URL:-}")
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
