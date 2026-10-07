---
description: Cut a full release (GitHub, Vercel install page, TestFlight), then install the new Mac app in /Applications and reopen it
---

Cut a full release of the Harness Mac and iPhone/iPad apps, following the **Releases** section of
CLAUDE.md exactly. This request approves the whole release: commit the changelog and any fixes the
release needs, create and push the tag, push `main`, run the publish, and commit the regenerated
install page, without stopping to ask again. It never covers moving, deleting, or force-pushing a
tag or `main`.

1. Work on `main` in the main checkout with a clean tree. Run `bun run sim disk` first and stop if
   it reports less than 5 GiB free.
2. Check that `## [Unreleased]` in CHANGELOG.md covers everything in
   `git log --no-merges <last app-* tag>..main` that someone using the apps would notice, and fill
   in anything missing.
3. `bun run release:prepare`, commit CHANGELOG.md as `Release app-…`, then
   `git tag -a app-… -m "Release app-…"` and `git push origin main app-…`.
4. Run `bun run release:publish` through an interactive login shell (`zsh -lic`; plain `-lc` skips `.zshrc`) so `ASC_KEY_ID` and
   `ASC_ISSUER_ID` are set, publishing to GitHub, the Vercel install page and TestFlight. It takes
   a long while: run it in the background and check on it. If it fails partway, fix the cause and
   rerun it on the same tag, as long as no GitHub release exists for it yet.
5. Commit the regenerated `release/Install/` files as `Install page: release app-…` and push `main`.
6. Every run of this command ends by copying the built Mac app into `/Applications`, the way
   dragging it there in Finder would. Never skip this step. Take the notarized zip the publish
   built, `release/build/release/Harness-mac.zip` (if it's missing, fetch the published one with
   `gh release download app-… --pattern Harness-mac.zip --dir <tmp>`), `ditto -x -k` it into a
   temp dir, `trash /Applications/Harness.app`, then `ditto` the new `Harness.app` into
   `/Applications`. Check it with `spctl -a -vv /Applications/Harness.app`, then `rm -rf` the temp
   dir (and the download dir, if you fetched the zip): each one holds a 540 MB copy of the app, and
   leftover ones have filled the disk before. Don't run `bun run install-app` (it packages from
   the checkout instead).
7. Report the tag, the GitHub release URL, https://harness-install.vercel.app, and the TestFlight
   status (submitted for review, or left unsubmitted behind an earlier build). In a Harness
   ticket, also bring the spec up to date and submit now, before step 8.
8. Then quit and reopen the app so the person using it sees the new version. A running Harness
   keeps the old build in memory until it quits, even though `/Applications` now holds the new
   one. Never skip this step. Quitting can stop the service, and with it this session, when the
   service runs inside the app rather than at login, so make this the last thing you do and run
   it detached, with a delay that leaves time for your final message:

   ```sh
   perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/sh -c 'sleep 20
     app=/Applications/Harness.app
     # A running build from before the move to the iPhone app bundle id has the old one: quit both.
     for id in com.markhuot.harness com.markhuot.harness.app; do
       osascript -e "tell application id \"$id\" to quit" 2>/dev/null
     done
     for i in $(seq 1 120); do pgrep -qf "$app/Contents/MacOS/Harness$" || break; sleep 1; done
     for i in $(seq 1 10); do open "$app"; sleep 3; pgrep -qf "$app/Contents/MacOS/Harness$" && break; done' \
     </dev/null >/dev/null 2>&1 &
   ```

   The script must reopen the app on its own, with nobody touching it. `setsid` gives it a session
   of its own, so it outlives the shell and the session that started it (a plain `nohup … &`
   can be stopped along with them before it reaches `open`). Both waits match the Mac app's
   executable path, not the process name, because the iPhone app in the simulator is also a
   `Harness` process. The `open` retries until the Mac app is running again. If you're still
   running when it should be back (the service runs at login), check with that same `pgrep`, and
   run `open /Applications/Harness.app` yourself if it isn't.

   If agents are mid-run and the service lives inside the app, Harness asks before quitting. That
   choice belongs to the person at the Mac, and the reopen just brings the app forward if they
   cancel. Don't restart the service yourself: the reopened app starts or reconnects to it.
