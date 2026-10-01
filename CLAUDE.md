# Harness

README.md covers setup and use, and DESIGN.md covers the architecture. `bun run test` and
`bun run typecheck` run from the repo root.

## Changelog

Every change that someone using the Mac or iPhone/iPad app would notice gets an entry under
`## [Unreleased]` in CHANGELOG.md, in the same commit or merge that makes the change. Group the
entries as Added, Changed, Fixed, or Removed, and write them for the person using the app (what
they'll see), not as commit messages. Internal-only changes (tests, sim-check, refactors) don't
need an entry.

## Simulators

Several agents build and test the iPhone app at once on a Mac with little free disk, so they share
one simulator and one runtime.

- Test only on the iOS 27.0 runtime, with
  `DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer`. Never download or install
  another runtime (`xcodebuild -downloadPlatform`, `xcrun simctl runtime add`, Xcode's Components
  settings, and so on). Each one takes about 8 GB. If 27.0 is missing, block and ask.
- Never create a simulator of your own. Use the shared one, `harness-shared` (an iPhone 18 Pro on
  iOS 27.0), through `bun run sim` (`mobile/Tools/sim.ts`). `bun run sim ensure` creates it the
  first time, boots it and prints its UDID. Don't use, shut down, or delete simulators that
  someone else owns (`harness-HARNESS-*`, `sim-check *`).
- Run everything that touches the simulator (install, launch, screenshots, AXe taps, sim-check,
  dev-sim) under its lock, so two agents never install different builds over each other:
  `bun run sim with-lock -- <command>`. It waits for the lock (30 minutes, `--timeout=minutes`),
  boots the device, runs the command with `SIM_UDID` set, and lets go when the command ends or
  dies. Hold it for one install-to-screenshot pass, not for a whole ticket. sim-check takes the
  lock itself.
- Before a heavy build (xcodebuild, sim-check, `release:publish`), run `bun run sim disk`. It exits
  1 when less than 5 GiB is free. Then block and ask rather than build.
- When you're done, delete your build output (`ios/build`, `ios/HarnessKit/.build`, `mobile/build/dd`)
  and leave the shared simulator alone. `bun run sim shutdown` shuts it down once nobody holds the
  lock, if it needs to stop.

## Releases

A git tag controls every release of the Mac and iPhone/iPad apps. Nothing gets published unless its
commit carries a release tag, and the release is exactly that commit.

**Tag names** follow `app-YYYYMMDD.HHMM`, where the timestamp is the UTC minute the release was
prepared (for example `app-20260927.1854`). Tags must be annotated (`git tag -a`), since
`publish-install.sh` ignores lightweight tags. The iOS build number (`CFBundleVersion`) is the
tag's digits (`202609271854`), which keeps it increasing from one release to the next as iOS
requires. The user-facing versions (`version` in `mobile/app.json` and `app/package.json`) change
only when someone decides to bump them. They don't identify a release; the tag does.

**Asking to cut a release approves the whole release.** A request to cut a release (or "ship",
"publish", or "deploy" the apps) is approval to commit the changelog and any fixes the release
needs, create and push the tag, push `main`, run the publish (GitHub release plus the Vercel
install page), and commit the regenerated install page. Don't stop to ask again before any of
those steps. That approval covers only the release it was given for. It doesn't carry over to
later work, and it never covers moving, deleting, or force-pushing a tag or `main`.

**Cutting a release** happens on `main` in the main checkout, with a clean tree:

1. Check that `## [Unreleased]` in CHANGELOG.md lists everything merged since the last tag
   (`git log --no-merges <last tag>..main`), and fill in anything missing.
2. Run `bun run release:prepare`. It moves the [Unreleased] entries into a new
   `## [app-…] - <date>` section and prints the tag name. It refuses an empty [Unreleased] and any
   tag that isn't newer than the last release.
3. Commit the changelog as `Release app-…`, then tag that commit with
   `git tag -a app-… -m "Release app-…"`.
4. Push the commit and the tag together: `git push origin main app-…`.
5. Run `bun run release:publish` (`mobile/Tools/publish-install.sh`) from that commit. Before
   building, it checks that HEAD carries an annotated `app-*` tag, the tree is clean, the tag's
   CHANGELOG section exists and is the newest, [Unreleased] is empty, origin has the tag at the
   same commit, the commit is on `origin/main`, and no GitHub release exists for the tag yet. It
   then builds the IPA and the Mac zip, notarizing the Mac app with the App Store Connect API key
   described under TestFlight below (set `NOTARY_PROFILE` to use a notarytool keychain profile
   instead, though a background session can't read one; the publish stops if Gatekeeper doesn't
   see a notarized app), and creates the GitHub release with
   `gh release create --verify-tag`, using the CHANGELOG section as the notes. Finally, it
   redeploys https://harness-install.vercel.app.
6. Commit the regenerated `mobile/Install/` files on `main` as `Install page: release app-…`. This
   commit changes only the install site, so it doesn't need a tag of its own.

A release commit prepared on a ticket branch works the same way. The tag goes on the branch's
release commit, and once the branch is merged and `main` is pushed, publish from that commit with
`git switch --detach app-…`, then `git switch main` for step 6.

If a publish fails partway, fix the cause and rerun it on the same tag, as long as no GitHub
release exists for that tag yet. Once a release is published, it stays: never move, delete, or
reuse a pushed tag. If a published build is broken, fix it on `main` and cut a new tag.

`publish-install.sh --no-publish` builds locally without any tag checks (add `--skip-ios` or
`--skip-mac` to build one app). An untagged build numbers itself from the clock.

`--ios-app=native` builds the iPhone and iPad app from the SwiftUI project in `ios/`
(`ios/Tools/build.ts`) instead of the React Native app in `mobile/`. The default is
`--ios-app=rn`, and releases use it until the native app reaches parity. With either value the
bundle id, build number, checks, TestFlight upload, GitHub release and install page are the same.
The IPA check looks for the SwiftUI binary instead of `main.jsbundle` (see ios/README.md →
Releases).

**TestFlight.** Step 5 also publishes the iPhone and iPad build to TestFlight
(`mobile/Tools/testflight.ts`), and nothing else has to be run by hand:

- Before building, it checks that it can reach App Store Connect: the API key, the app record for
  `com.markhuot.harness`, and the `Public` group. It stops there if it can't.
- After exporting the development IPA, it exports the same archive with
  `mobile/ExportOptions-testflight.plist` and uploads it to App Store Connect, signed in with the
  same API key (not the Apple account in Xcode's settings, whose saved sign-in expires). Warnings
  about missing dSYMs for prebuilt frameworks (React, hermesvm, Expo) are expected.
- It waits for App Store Connect to process the build, sets What to Test from the CHANGELOG
  section, adds the build to the external `Public` group and submits it for Beta App Review. Testers
  get the build once Apple approves it, usually within a day. Only one build of a version can wait
  in review, so while an earlier release's build is still there, the publish leaves the new build
  in the group unsubmitted and says so. Submit it once the earlier one clears with
  `bun mobile/Tools/testflight.ts distribute <build number>` (from `mobile/`, as
  `bun Tools/testflight.ts distribute …`).
- It writes the group's public link (https://testflight.apple.com/join/M8kvbuv1) on the install
  page as the **Get it on TestFlight** button.

It needs `ASC_KEY_ID` and `ASC_ISSUER_ID` exported in the shell that publishes, for the team API
key (App Manager or higher) whose `.p8` is in `~/.appstoreconnect/private_keys/`. The IDs aren't
secrets, but this repo is public, so they live in the shell profile, not here. A rerun on the same
tag skips an upload that already happened, since App Store Connect never accepts a build number
twice. `--skip-testflight` publishes without TestFlight. If Beta App Review rejects a build, the
release still stands. Fix the cause, then cut a new tag.

The app record and the Test Information (description, privacy policy, feedback email, review
contact) are already set up. If they ever need to change, rerun `bun mobile/Tools/testflight.ts
setup` with `ASC_FEEDBACK_EMAIL` and the `ASC_CONTACT_FIRST`/`_LAST`/`_EMAIL`/`_PHONE` variables.

**The Mac zip only runs on the Mac that built it.** `app/scripts/build.ts` writes that Mac's
Harness checkout and `bun` paths into the app, so on another Mac the service doesn't start.
Notarizing doesn't change that. Until the app carries its own service, the install page tells
people to build the Mac app from the repo (`MAC_SOURCE_NOTE` in `mobile/Tools/install-page.ts`).

The four tags up to and including `app-20260927.1854` came from `gh release create` without
`--verify-tag`, which made the tag at origin's `main` tip at publish time. Those tags can point at
a slightly different commit than the one that was built. Leave them as they are.
