# Harness

README.md covers setup and use, and DESIGN.md covers the architecture. `bun run testing` is the
check every change passes before it lands on `main` (below); `bun run test` runs its fast layers and
`bun run typecheck` runs tsc over every project.

## Changelog

Every change gets an entry under `## [Unreleased]` in CHANGELOG.md, in the same commit or merge
that makes the change. That includes changes only agents see (their tools, prompts and
instructions) and internal ones (tests, build and release scripts, refactors). Group the
entries as Added, Changed, Fixed, or Removed, and write each one for the person using the app: say
what they or their agents will see or can now do, not what the commit did. For an internal change,
say in a plain sentence what it changes for the people working on Harness.

## Verifying changes

**A change doesn't land until `bun run testing` passes on the result.** That is the one gate: it runs
the whole suite in `testing/` (its README describes each layer), runs every layer, and prints which
failed. There is no hosted CI; it runs on this Mac. A completion run (the one that merges a ticket)
runs it on the merged result and fixes or reports what fails before anything lands on `main`.

**One heavy run at a time.** Several agents running the suite at once overloaded this Mac and slowed
every run to over an hour, so everything past `lint` and `l0` (`mac`, `ios`, `walk`, `stress`,
`fast`, and the full gate) takes a lock shared by every worktree and the main checkout
(`testing/queue-lock.ts`). A run that finds it taken queues in arrival order and waits inside the
command. When its turn comes it prints `testing: your turn started`, stops the orphans of earlier
runs (xcodebuild, swift-build, the checkout's Electron, simulators nobody holds), then waits up to a
minute for the machine's load to settle before the first test.

- Run the gate as a background command (`run_in_background`, `timeout: 7200000`) and end your turn
  or do other work: you are woken when it exits. Never `sleep` or poll for it. To see your turn
  start, Monitor its output for `your turn started`.
- A queued command isn't hung or failed, and killing it to retry loses your place. `bun run testing queue`
  shows the holder and the waiters. A killed or crashed run drops out of the line by itself.
- Only the lock holder runs tests, so a leftover `xcodebuild` or `node_modules/electron` Electron of
  an earlier run you find while you hold the lock is an orphan: kill it (and `bun run sim shutdown`
  for simulators) instead of working around it. The run does this itself, but only when the
  previous holder died without letting go; it never touches `swift test` (the ungated `l0`), release
  builds or other agents' own simulators. Never kill processes of apps you didn't start (Slack, the installed Harness).
- Don't go around it with raw `cd testing && bun test`, `xcodebuild` or `dev-sim` for the full gate; a
  single layer run through `bun run testing <layer>` is fine. Rebase onto `main` first if your
  worktree has no `testing/queue-lock.ts`.

A change isn't done until it has a test, `bun run testing` and `bun run typecheck` pass, and a
visible change has screenshots in the spec's Status. A ticket worktree starts without
`node_modules`: clone the main checkout's with `cp -Rc /Users/markhuot/Sites/harness/node_modules .`
(copy-on-write) or run `bun install`. That failure is yours to fix, not a reason to submit
unverified.

While you work, use the lowest layer that can see the bug, and write the logic first. Run the full
gate once when you're done, not after every edit.

1. **Logic** (routing, counting, layout math, request bodies, state rules): `bun run testing l0`
   (bun logic tests in `testing/l0` and the Swift package in `testing/swift`, side by side). Seconds.
2. **Service behaviour**: `bun test` inside `testing/` (L1–L3: the service, its API and the wire
   contract), or one file with `cd testing && bun test <path>`.
3. **Mac views**: `bun run testing mac` (React under happy-dom against the shared world).
4. **A screen's look** in the iPhone, iPad and iPhone Duo apps: `bun run testing ios` (`--iphone`, `--ipad`, `--duo`,
   `--only=ScreenTests/<test>`; `--out=<dir>` writes the renders for a spec's screenshots;
   `--record` updates the references after an intended change, and you read the diff). It builds
   once and reuses the build while the sources are unchanged.
5. **Real taps, IPC, relaunch**: `bun run testing walk` (`--out=<dir>` for screenshots), the one
   journey through the real service, Mac app, iPhone and iPad. It is the last layer of the gate.

`bun run test` runs the layers that need no simulator and no Electron (`bun run testing fast`), and
`bun run testing lint` checks that tests don't import each other's data.

## Simulators

Several agents build and test the iPhone app at once on a Mac with little free disk, so they share
one runtime and a small pool of simulators.

- Test iPhone and iPad only on the iOS 27.0 runtime and the iPhone Duo only on iOS 27.1 (the 27.1
  runtime supports no other device), always with Xcode 27.1:
  `DEVELOPER_DIR=/Applications/Xcode-27.1.0.app/Contents/Developer`. Never download or install
  another runtime (`xcodebuild -downloadPlatform`, `xcrun simctl runtime add`, Xcode's Components
  settings, and so on). Each one takes about 8 GB. If 27.0 or 27.1 is missing, block and ask.
- Never create a simulator of your own. Use the shared pool through `bun run sim`
  (`ios/Tools/sim.ts`): `harness-shared` and `harness-shared-2` (iPhones; the lock takes whichever is
  free) and `harness-shared-ipad` for `--ipad` and `harness-shared-duo` for `--duo`. Don't use, shut down, or delete simulators someone
  else owns (`harness-HARNESS-*`).
- Run everything that touches a simulator (install, launch, screenshots, AXe taps, dev-sim) under its
  lock, so two agents never install different builds over each other:
  `bun run sim with-lock -- <command>`. Hold it for one install-to-screenshot pass, not for a whole
  ticket. `bun run testing ios` and `bun run testing walk` take the lock themselves.
- Before a heavy build (xcodebuild, `bun run testing ios` or `walk`, `release:publish`), run
  `bun run sim disk`. It exits 1 when less than 5 GiB is free: then block and ask rather than
  build. It also names any iOS runtime other than 27.0 and 27.1; pass that on to the human, don't delete it.
  `testing ios` and `testing walk` run it before they build.
- The walkthrough records every process it starts and kills them when it ends; the next run reaps
  what a killed one left. Don't kill its processes by hand.
- When you're done, delete your build output (`ios/build`, `ios/HarnessKit/.build`,
  `testing/.build`, `testing/.walk`) and leave the shared simulators alone. `bun run sim shutdown`
  stops the pool simulators nobody holds.

## Releases

A git tag controls every release of the Mac and iPhone/iPad apps. Nothing gets published unless its
commit carries a release tag, and the release is exactly that commit.

**Tag names** follow `app-YYYYMMDD.HHMM`, where the timestamp is the UTC minute the release was
prepared (for example `app-20260927.1854`). Tags must be annotated (`git tag -a`), since
`publish-install.sh` ignores lightweight tags. The iOS build number (`CFBundleVersion`) is the
tag's digits (`202609271854`), which keeps it increasing from one release to the next as iOS
requires. The user-facing versions (`MARKETING_VERSION` in `ios/project.yml` and `version` in
`app/package.json`) change only when someone decides to bump them. They don't identify a release; the tag does.

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
5. Run `bun run release:publish` (`release/publish-install.sh`) from that commit. Before
   building, it checks that HEAD carries an annotated `app-*` tag, the tree is clean, the tag's
   CHANGELOG section exists and is the newest, [Unreleased] is empty, origin has the tag at the
   same commit, the commit is on `origin/main`, and no GitHub release exists for the tag yet. It
   then builds the IPA (the SwiftUI app in `ios/`, through `ios/Tools/build.ts`) and the Mac
   zip, notarizing the Mac app with the App Store Connect API key described under TestFlight below (set `NOTARY_PROFILE` to use a notarytool keychain profile
   instead, though a background session can't read one; the publish stops if Gatekeeper doesn't
   see a notarized app), and creates the GitHub release with
   `gh release create --verify-tag`, using the CHANGELOG section as the notes. Finally, it
   redeploys https://harness-install.vercel.app.
6. Commit the regenerated `release/Install/` files on `main` as `Install page: release app-…`. This
   commit changes only the install site, so it doesn't need a tag of its own.

A release commit prepared on a ticket branch works the same way. The tag goes on the branch's
release commit, and once the branch is merged and `main` is pushed, publish from that commit with
`git switch --detach app-…`, then `git switch main` for step 6.

If a publish fails partway, fix the cause and rerun it on the same tag, as long as no GitHub
release exists for that tag yet. Once a release is published, it stays: never move, delete, or
reuse a pushed tag. If a published build is broken, fix it on `main` and cut a new tag.

`publish-install.sh --no-publish` builds locally without any tag checks (add `--skip-ios` or
`--skip-mac` to build one app). An untagged build numbers itself from the clock.

**TestFlight.** Step 5 also publishes the iPhone and iPad build to TestFlight
(`release/testflight.ts`), and nothing else has to be run by hand:

- Before building, it checks that it can reach App Store Connect: the API key, the app record for
  `com.markhuot.harness`, and the `Public` group. It stops there if it can't.
- After exporting the development IPA, it exports the same archive with
  `ios/ExportOptions-testflight.plist` and uploads it to App Store Connect, signed in with the
  same API key (not the Apple account in Xcode's settings, whose saved sign-in expires). Warnings
  about missing dSYMs may appear and can be ignored.
- It waits for App Store Connect to process the build, sets What to Test from the CHANGELOG
  section, adds the build to the external `Public` group and submits it for Beta App Review. Testers
  get the build once Apple approves it, usually within a day. Only one build of a version can wait
  in review, so while an earlier release's build is still there, the publish leaves the new build
  in the group unsubmitted and says so. Submit it once the earlier one clears with
  `bun release/testflight.ts distribute <build number>` (from the repo root).
- It writes the group's public link (https://testflight.apple.com/join/M8kvbuv1) on the install
  page as the **Get it on TestFlight** button.

It needs `ASC_KEY_ID` and `ASC_ISSUER_ID` exported in the shell that publishes, for the team API
key (App Manager or higher) whose `.p8` is in `~/.appstoreconnect/private_keys/`. The IDs aren't
secrets, but this repo is public, so they live in the shell profile, not here. A rerun on the same
tag skips an upload that already happened, since App Store Connect never accepts a build number
twice. `--skip-testflight` publishes without TestFlight. If Beta App Review rejects a build, the
release still stands. Fix the cause, then cut a new tag.

The app record and the Test Information (description, privacy policy, feedback email, review
contact) are already set up. If they ever need to change, rerun `bun release/testflight.ts
setup` with `ASC_FEEDBACK_EMAIL` and the `ASC_CONTACT_FIRST`/`_LAST`/`_EMAIL`/`_PHONE` variables.

**The Mac zip carries its own service.** `bun run package` compiles the service into
`Contents/MacOS/harness-service` (`service/scripts/compile.ts`, a `bun build --compile` of the
daemon and CLI) with the builtin plugins prebuilt in `Contents/Resources/plugins`, so it runs on
any Mac without bun or a checkout. The publish refuses a zip without them. `bun run install-app`
is different: it packages with `--checkout`, so the app on this Mac runs the service from this
checkout and restarts onto new code when a ticket merges.

The four tags up to and including `app-20260927.1854` came from `gh release create` without
`--verify-tag`, which made the tag at origin's `main` tip at publish time. Those tags can point at
a slightly different commit than the one that was built. Leave them as they are.
