# Harness for iPhone and iPad

The iPhone and iPad app, in SwiftUI (version 2.0, which replaced the 1.x React Native app).
`shared/` is the spec for everything the app shares with the desktop: the wire contract tests in
`testing/contract` hold the Swift protocol types to `shared/src/protocol.ts`. See
[ARCHITECTURE.md](ARCHITECTURE.md).

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
configuration for the simulator without optimization (`-Onone`, one file at a time: a clean build takes about 40 s instead of 120 s; `--optimized` turns it back on), ad-hoc signed (the simulator only grants the Keychain to a signed app) and arm64 only, into
`ios/build/dd/Build/Products/Release-iphonesimulator/Harness.app`. Install it with `simctl` and launch `com.markhuot.harness`.

## ios/Tools/build.ts

Every command regenerates `Harness.xcodeproj` first, builds into `ios/build/dd`, writes
xcodebuild's output to `ios/build/<command>.log` and prints only the last 40 lines when it fails.
The path of what it built is the only line on stdout.

| Command | Builds |
| --- | --- |
| `sim [--optimized]` | Release settings (unoptimized unless `--optimized`), iphonesimulator, ad-hoc signed, arm64 |
| `device --device <name or UDID> [--launch]` | Debug, installed with `xcrun devicectl` |
| `archive --build-number N` | Release archive for devices at `ios/build/Harness.xcarchive`, `CFBundleVersion` N |
| `export --method dev` | development-signed `ios/build/ipa-dev/Harness.ipa` (`ExportOptions.plist`) |
| `export --method testflight` | uploads the archive to App Store Connect (`ExportOptions-testflight.plist`); needs `ASC_KEY_ID` and `ASC_ISSUER_ID` |
| `verify --bundle-id ID --build-number N <Harness.app>` | checks an unpacked app (see below) |

`archive` and `export` sign automatically with team `47P4ZSALX4` and pass
`-allowProvisioningUpdates`, with `ios/ExportOptions.plist` (dev) or
`ios/ExportOptions-testflight.plist` (testflight).

## Tests

All of the app's tests live in the top-level `testing/` directory (its README describes each layer),
and `bun run testing` runs them. A change doesn't land until that passes.

- **Logic** (protocol decoding, request bodies, view rules) runs on the Mac host with no simulator:
  `bun run testing l0`, which builds the Swift package in `testing/swift` against HarnessKit and
  HarnessHighlight. App builds need bun too, for the "Bundle highlighter" phase, so run
  `bun install` at the repo root once.
- **Screens** render in a test bundle hosted by the app, from the shared world in `testing/world`,
  and are compared with reference images on the shared iPhone and iPad simulators:
  `bun run testing ios` (`--record` to update the references, `--out=<dir>` to write the renders,
  e.g. for a spec's screenshots).
- **The walkthrough** (`bun run testing walk`) runs one journey through the real service, the Mac
  app, and the iPhone and iPad apps.
- **Themes resource.** `HarnessKit/Sources/HarnessKit/Resources/themes.json` is generated from
  `shared/src`; after changing the themes, project colors or icons, run
  `bun shared/scripts/export-themes.ts` (a test fails while the committed file is stale).

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

`ios/Tools/dev-sim.ts` looks at one screen on the shared simulator, `harness-shared` (see
CLAUDE.md → Simulators and ARCHITECTURE.md → Disk budget):

```sh
bun ios/Tools/dev-sim.ts [--no-build] [--link harness://ticket/GREET-1?tab=details]… [--shot details] [--keep]
```

It boots `harness-shared` (an iPhone 18 Pro on iOS 27.0, created the first time it's needed; it
never downloads a runtime). `--sim <name>` picks another simulator,
which has to exist already. It starts a throwaway daemon (temp `HARNESS_HOME`, a free
port, the dummy driver) and seeds the `GREET` project, a git repo with worktrees, with GREET-1 in
review (with three sub-agents, for its Agents & tasks tab), GREET-2 in planning, GREET-3 blocked, GREET-4 done, GREET-5 waiting on GREET-1, and GREET-6 in
review with agent notes (for the Details tab). It builds with
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
(`brew install cameroncooke/axe/axe`; it refuses to run without it). After
each `openurl` it taps Open on iOS's "Open in “Harness”?" prompt, which the first link on a fresh
simulator stops at. Pairing counts only once the board's column chips ("Planning, 1") show, and a
link only once the screen changes. Otherwise the run exits 1 with the labels it saw, before any
screenshot, and it cancels a leftover prompt first, so a stale pair link can't be accepted later.
To read the screen yourself, `axe describe-ui` lists the AXLabels. It needs the Xcode shim that
dev-sim and the walkthrough create:
`DEVELOPER_DIR=~/Library/Caches/harness-xcode-shim/xcode-shim/Xcode.app/Contents/Developer axe describe-ui --udid <udid>`.

`--seed-only [--keep]` only starts and seeds the daemon and prints what it seeded, without a
simulator, build or app.

When the ticket is done, delete `ios/build`, `ios/HarnessKit/.build` and `testing/.build`. Leave the simulator alone.
