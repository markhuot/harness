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
with team `47P4ZSALX4`. Plug the device in, open `Harness.xcodeproj`, pick the device and
press Run, or:

```sh
xcodebuild -project Harness.xcodeproj -scheme Harness -destination 'platform=iOS,name=<device name>' \
  -allowProvisioningUpdates -derivedDataPath build/dd build
xcrun devicectl device install app --device <device name> build/dd/Build/Products/Debug-iphoneos/Harness.app
```

The native app isn't part of `release:publish` yet. The RN app still ships.
