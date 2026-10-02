# Harness for iPhone and iPad

The iPhone and iPad app, in SwiftUI (version 2.0, which replaced the 1.x React Native app).
`shared/` is the spec for everything the app shares with the desktop, through generated fixtures.
For logic that only the phone has (and that used to live in the React Native app's TypeScript),
the frozen fixtures in `HarnessKit/Tests/HarnessKitTests/Fixtures/` are the spec, and `swift test`
owns them. See [ARCHITECTURE.md](ARCHITECTURE.md).

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

From the repo root (`bun run sim` is a root script, so it isn't found from `ios/`):

```sh
bun run sim disk   # exits 1 under 5 GiB free: block and ask instead of building
(cd ios && xcodegen && xcodebuild -project Harness.xcodeproj -scheme Harness -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build/dd build)

# on the shared simulator, under its lock (CLAUDE.md → Simulators)
bun run sim with-lock -- sh -c 'xcrun simctl install "$SIM_UDID" ios/build/dd/Build/Products/Debug-iphonesimulator/Harness.app && xcrun simctl launch "$SIM_UDID" com.markhuot.harness'
```

Or open `Harness.xcodeproj` in Xcode and press Run.

`bun ios/Tools/build.ts sim` (from the repo root) runs XcodeGen and builds the Release
configuration for the simulator, ad-hoc signed (the simulator only grants the Keychain to a signed app) and arm64 only, into
`ios/build/dd/Build/Products/Release-iphonesimulator/Harness.app`. That's the build sim-check
will drive. Install it with `simctl` and launch `com.markhuot.harness`.

## ios/Tools/build.ts

Every command regenerates `Harness.xcodeproj` first, builds into `ios/build/dd`, writes
xcodebuild's output to `ios/build/<command>.log` and prints only the last 40 lines when it fails.
The path of what it built is the only line on stdout.

| Command | Builds |
| --- | --- |
| `sim` | Release, iphonesimulator, ad-hoc signed, arm64 |
| `device --device <name or UDID> [--launch]` | Debug, installed with `xcrun devicectl` |
| `archive --build-number N` | Release archive for devices at `ios/build/Harness.xcarchive`, `CFBundleVersion` N |
| `export --method dev` | development-signed `ios/build/ipa-dev/Harness.ipa` (`ExportOptions.plist`) |
| `export --method testflight` | uploads the archive to App Store Connect (`ExportOptions-testflight.plist`); needs `ASC_KEY_ID` and `ASC_ISSUER_ID` |
| `verify --bundle-id ID --build-number N <Harness.app>` | checks an unpacked app (see below) |

`archive` and `export` sign automatically with team `47P4ZSALX4` and pass
`-allowProvisioningUpdates`, with `ios/ExportOptions.plist` (dev) or
`ios/ExportOptions-testflight.plist` (testflight).

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

Frozen fixtures are never regenerated: their values came from the 1.x React Native app's
TypeScript, and the committed JSON is now the spec. A whole frozen file is listed in `FROZEN` in
`shared/scripts/export-fixtures.ts` and has no case file; a case file that mixes computed and
frozen values reads the frozen ones back with `frozen(module, key)`. Change one by editing the
JSON along with the Swift that has to match it.

## Run on a device

Every configuration is `com.markhuot.harness` ("Harness"), so a Debug build replaces a TestFlight
or release install on the same device, and the other way around. Signing is automatic with team
`47P4ZSALX4`, and the device must be registered to the team (plug it in once with Xcode open).
Plug the device in, open `Harness.xcodeproj`, pick the device and press Run, or:

```sh
xcrun devicectl list devices          # the device's name or UDID
bun ios/Tools/build.ts device --device "<device name>" --launch
```

## Releases

`bun run release:publish` (`release/publish-install.sh`) ships this app. To build it locally
without publishing:

```sh
release/publish-install.sh --no-publish --skip-mac --skip-testflight
```

That runs `archive --build-number <tag digits>` (or a clock-based number when untagged) and
`export --method dev`, unpacks the IPA and runs `verify`. The check needs the bundle id
`com.markhuot.harness`, a `CFBundleVersion` equal to the build number and an arm64 executable that
links SwiftUI; the publish script also checks that no readable pairing token is anywhere in the
app. The user-facing version is `MARKETING_VERSION` in `project.yml`. `--skip-ios`, `--skip-mac`,
`--skip-testflight` and `--no-publish` pick what runs. See CLAUDE.md → Releases for the whole
process.

## Dev loop (the shared simulator)

`ios/Tools/dev-sim.ts` checks one screen on the shared simulator, `harness-shared` (see
CLAUDE.md → Simulators and ARCHITECTURE.md → Disk budget):

```sh
bun ios/Tools/dev-sim.ts [--no-build] [--link harness://ticket/GREET-1?tab=details]… [--shot details] [--keep]
```

It boots `harness-shared` (an iPhone 18 Pro on iOS 27.0, created the first time it's needed; it
never downloads a runtime). `--sim <name>` picks another simulator,
which has to exist already. It starts a throwaway daemon (temp `HARNESS_HOME`, a free
port, the dummy driver) and seeds the `GREET` project, a git repo with worktrees, with GREET-1 in
review, GREET-2 in planning, GREET-3 blocked and GREET-4 done. It builds with
`bun ios/Tools/build.ts sim` (skip that with `--no-build`, or install another build with
`--app <path>`), refusing to build with less than 5 GiB free. Then it takes the simulator's lock
(printing "waiting for the harness-shared simulator…" while another agent holds it), installs the
app fresh (uninstalled first, keychain reset) and pairs it with the `harness://pair?…` link. It
also uninstalls any build left from the old Debug bundle id (`com.markhuot.harness.dev`) on the
shared simulator, since that registers `harness://` too and could catch the pair link. Each
`--link` opens in order after that, and `--shot NAME` saves `ios/build/screens/NAME-light.png` and
`NAME-dark.png`. The lock is held from the install to the last screenshot. Under
`bun run sim with-lock -- bun ios/Tools/dev-sim.ts …` it's already held. The run ends by stopping
the daemon and deleting its temp home, unless `--keep` leaves the daemon up (it prints the URL,
token path and pid) until Ctrl-C. `--keep` lets go of the simulator lock first, so another agent
may reinstall the app in the meantime.

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

`ios/Tools/sim-check.ts` walks the whole app on the same simulator and under the same lock:

```sh
bun ios/Tools/sim-check.ts --only=connect     # or: bun run --cwd ios sim-check --only=connect
```

It builds with `build.ts sim` (skip with `--no-build`), installs
`ios/build/dd/Build/Products/Release-iphonesimulator/Harness.app` and saves screenshots to
`ios/build/screens/` (`--ipad`: `ios/build/screens-ipad/`). `--udid` still names a specific
existing simulator. The header of `sim-check.ts` lists every mode.

When the ticket is done, delete `ios/build` and `ios/HarnessKit/.build`. Leave the simulator alone.
