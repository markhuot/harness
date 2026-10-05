---
description: Cut a full release (GitHub, Vercel install page, TestFlight), then install the new Mac app in /Applications
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
   `/Applications`. Check it with `spctl -a -vv /Applications/Harness.app`. Only copy the app:
   don't restart the service, quit or relaunch the app, or run `bun run install-app`. The app
   notices the new version and restarts the service itself.
7. Report the tag, the GitHub release URL, https://harness-install.vercel.app, and the TestFlight
   status (submitted for review, or left unsubmitted behind an earlier build).
