# Harness for iPhone and iPad (native)

A SwiftUI re-implementation of the React Native app in `mobile/`. The two live side by side
until the native app reaches parity (see [ARCHITECTURE.md](ARCHITECTURE.md) § Parity checklist).
The RN app and `shared/` are the spec.

Disk is tight and several tickets build at once. Follow [ARCHITECTURE.md § Disk budget](ARCHITECTURE.md#disk-budget-parallel-agents) (one simulator, `-derivedDataPath ios/build/dd`, clean up when done).

Every command below needs Xcode 27. When `xcode-select` points at the Command Line Tools, set:

```sh
export DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer
```

## Generate the Xcode project

`Harness.xcodeproj` is generated from `project.yml` by [XcodeGen](https://github.com/yonaskolb/XcodeGen)
and gitignored. Regenerate it after pulling, or after adding or removing files:

```sh
cd ios && xcodegen
```

## Build and run in the simulator

```sh
cd ios
xcodebuild -project Harness.xcodeproj -scheme Harness -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build/dd build

# once: a simulator of your own (never reuse the "sim-check …" ones)
xcrun simctl create harness-<KEY> com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0
xcrun simctl boot harness-<KEY>
xcrun simctl install harness-<KEY> build/dd/Build/Products/Debug-iphonesimulator/Harness.app
xcrun simctl launch harness-<KEY> com.markhuot.harness.dev
```

Or open `Harness.xcodeproj` in Xcode and press Run.

`bun ios/Tools/build.ts sim` (from the repo root) runs XcodeGen and builds the Release
configuration for the simulator, ad-hoc signed (the simulator only grants the Keychain to a signed app) and arm64 only, into
`ios/build/dd/Build/Products/Release-iphonesimulator/Harness.app`. That's the build sim-check
will drive. It's `com.markhuot.harness`, so install it with `simctl` and launch that id.

## ios/Tools/build.ts

Every command regenerates `Harness.xcodeproj` first, builds into `ios/build/dd`, writes
xcodebuild's output to `ios/build/<command>.log` and prints only the last 40 lines when it fails.
The path of what it built is the only line on stdout.

| Command | Builds |
| --- | --- |
| `sim` | Release, iphonesimulator, ad-hoc signed, arm64 |
| `device --device <name or UDID> [--launch]` | Debug ("Harness Dev"), installed with `xcrun devicectl` |
| `archive --build-number N` | Release archive for devices at `ios/build/Harness.xcarchive`, `CFBundleVersion` N |
| `export --method dev` | development-signed `ios/build/ipa-dev/Harness.ipa` (`ExportOptions.plist`) |
| `export --method testflight` | uploads the archive to App Store Connect (`ExportOptions-testflight.plist`); needs `ASC_KEY_ID` and `ASC_ISSUER_ID` |
| `verify --kind native --bundle-id ID --build-number N <Harness.app>` | checks an unpacked app (see below) |

`archive` and `export` sign automatically with team `47P4ZSALX4` and pass
`-allowProvisioningUpdates`. `ExportOptions*.plist` are copies of the RN app's in `mobile/`, and
`ios/Tools/build.test.ts` fails if they drift apart.

## Tests

- **HarnessKit** (protocol, client, logic) and **HarnessHighlight** run on the Mac host, with no simulator:
  `cd ios/HarnessKit && swift test`. The highlighter tests bundle Shiki with bun first, so run
  `bun install` at the repo root once. App builds need bun too, for the "Bundle highlighter" phase.
- **Service integration** starts a real daemon on a temp `HARNESS_HOME` and drives it with
  `HarnessClient`: `HARNESS_INTEGRATION=1 swift test --filter Integration` (from `ios/HarnessKit`;
  needs `bun` on `PATH`).
- **Config and fixtures** (bun): `bun run test` from the repo root covers `ios/Tools/config.test.ts`
  (Info.plist keys in `project.yml`) and `shared/src/fixtures.test.ts` (fixture freshness).

After changing a case file in `shared/fixtures/` or TS logic it exercises, regenerate the JSON:

```sh
bun shared/scripts/export-fixtures.ts
```

## Run on a device

Debug builds are `com.markhuot.harness.dev` ("Harness Dev"), so they install beside the RN
app. Release builds are `com.markhuot.harness` ("Harness") and replace it. Signing is automatic
with team `47P4ZSALX4`, and the device must be registered to the team (plug it in once with
Xcode open). Plug the device in, open `Harness.xcodeproj`, pick the device and press Run, or:

```sh
xcrun devicectl list devices          # the device's name or UDID
bun ios/Tools/build.ts device --device "<device name>" --launch
```

### Harness Dev beside the RN app

Harness Dev and the RN app (or a TestFlight build) can be installed together. Both register the `harness://` URL scheme, so iOS may open a scanned pairing QR
code in either one, and you can't choose which. To pair the one you want, use Scan QR code inside
that app, or enter the server and token by hand. Manual entry always works.

## Releases

`release:publish` still ships the RN app from `mobile/`. With `--ios-app=native` it ships this
app instead:

```sh
mobile/Tools/publish-install.sh --no-publish --skip-mac --skip-testflight --ios-app=native
```

That runs `archive --build-number <tag digits>` and `export --method dev`, unpacks the IPA and runs
`verify --kind native`. The check needs the Release bundle id `com.markhuot.harness`, a
`CFBundleVersion` equal to the build number, an arm64 executable that links SwiftUI, no
`main.jsbundle` or React/Hermes frameworks (so the RN app can't ship by mistake), and no readable
pairing token anywhere in the app. The TestFlight upload, GitHub release and install page are
the same as for the RN app. The bundle id is the same too, so the native build replaces the RN app
on TestFlight and on devices. `--no-publish`, `--skip-ios`, `--skip-mac` and `--skip-testflight`
work with either app. See CLAUDE.md → Releases for the whole process.

## Dev loop (one simulator per ticket)

`ios/Tools/dev-sim.ts` checks one screen on a simulator of the ticket's own, so parallel tickets
never drive each other's (see ARCHITECTURE.md → Disk budget):

```sh
bun ios/Tools/dev-sim.ts --sim harness-<KEY> [--no-build] [--link harness://ticket/GREET-1?tab=details]… [--shot details] [--keep]
```

It creates the simulator if it's missing (an iPhone 18 Pro on the newest installed iOS runtime;
it never downloads one) and boots it. It starts a throwaway daemon (temp `HARNESS_HOME`, a free
port, the dummy driver) and seeds the `GREET` project, a git repo with worktrees, with GREET-1 in
review, GREET-2 in planning, GREET-3 blocked and GREET-4 done. It builds with
`bun ios/Tools/build.ts sim` (skip that with `--no-build`, or install another build with
`--app <path>`), refusing to build with less than 5 GiB free. Then it installs the app fresh
(uninstalled first, keychain reset) and pairs it with the `harness://pair?…` link. Each `--link`
opens in order after that, and `--shot NAME` saves `ios/build/screens/NAME-light.png` and
`NAME-dark.png`. The run ends by stopping the daemon and deleting its temp home, unless `--keep`
leaves it up (it prints the URL, token path and pid) until Ctrl-C.

dev-sim checks the screen with [AXe](https://github.com/cameroncooke/AXe)
(`brew install cameroncooke/axe/axe`; it refuses to run without it), as sim-check does. After
each `openurl` it taps Open on iOS's "Open in “Harness”?" prompt, which the first link on a fresh
simulator stops at. Pairing counts only once the board's column chips ("Planning, 1") show, and a
link only once the screen changes. Otherwise the run exits 1 with the labels it saw, before any
screenshot, and it cancels a leftover prompt first, so a stale pair link can't be accepted later.
To read the screen yourself, `axe describe-ui` lists the AXLabels. It needs the Xcode shim that
dev-sim and sim-check create:
`DEVELOPER_DIR=~/Library/Caches/harness-sim-check/xcode-shim/Xcode.app/Contents/Developer axe describe-ui --udid <udid>`.

`--seed-only [--keep]` only starts and seeds the daemon and prints what it seeded, without a
simulator, build or app.

sim-check can walk the native app too, on the same simulator:

```sh
cd mobile && bun scripts/sim-check.ts --native --udid=harness-<KEY> --only=connect
```

`--native` builds with `build.ts sim`, installs
`ios/build/dd/Build/Products/Release-iphonesimulator/Harness.app` and saves to
`mobile/build/screens-native/`. `--udid` takes a simulator's name or UDID. It has to exist already
(dev-sim creates it), and naming it keeps sim-check off its shared `sim-check N` simulators.

When the ticket is done, delete the simulator with `xcrun simctl delete harness-<KEY>`, along with
`ios/build` and `ios/HarnessKit/.build`.
