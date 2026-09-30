# Harness

README.md covers setup and use, and DESIGN.md covers the architecture. `bun run test` and
`bun run typecheck` run from the repo root.

## Changelog

Every change that someone using the Mac or iPhone/iPad app would notice gets an entry under
`## [Unreleased]` in CHANGELOG.md, in the same commit or merge that makes the change. Group the
entries as Added, Changed, Fixed, or Removed, and write them for the person using the app (what
they'll see), not as commit messages. Internal-only changes (tests, sim-check, refactors) don't
need an entry.

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
   then builds the IPA and the Mac zip, notarizing the Mac app with the notarytool keychain
   profile `harness` (override with `NOTARY_PROFILE`; the publish stops if Gatekeeper doesn't
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

The four tags up to and including `app-20260927.1854` came from `gh release create` without
`--verify-tag`, which made the tag at origin's `main` tip at publish time. Those tags can point at
a slightly different commit than the one that was built. Leave them as they are.
