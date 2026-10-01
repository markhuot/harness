# Native iOS app: architecture and conventions

The native app is a SwiftUI rewrite of the React Native app in `mobile/`. It talks to the same
service over the same HTTP API and WebSocket (DESIGN.md § HTTP API, § Network). Until it reaches
parity, both apps are maintained. `mobile/` and `shared/` are the spec: when this app and the RN app
disagree about behavior, the RN app wins unless a ticket says otherwise. It doesn't have to look
the same. Use native SwiftUI patterns (NavigationStack, `.sheet`, `Menu`, `.searchable`,
swipe actions, drag and drop). iPhone is the primary target. The build is universal, so iPad must
keep working, but iPad-specific layouts are separate work.

## Layout

```
ios/
  project.yml            XcodeGen spec (source of truth for the app target and Info.plist)
  Harness/               the app target: SwiftUI only (views, navigation, SwiftUI bridges)
    HarnessApp.swift     @main App (SwiftUI App lifecycle = UIScene lifecycle)
    Resources/           Assets.xcassets (AppIcon, LaunchBackground, SplashIcon)
    Theme/               Color(css:) and other SwiftUI bridges for HarnessKit types
  HarnessKit/            Swift package: everything that doesn't draw
    Sources/HarnessKit/
      Protocol/          Codable ports of shared/src/protocol.ts
      Client/            HarnessClient (REST), HarnessSocket (WebSocket), HTTPTransport seam
      Logic/             pure helpers ported from shared/ and mobile/src/lib
      State/             @Observable app state (stores, reducers)
      Resources/         generated JSON bundled with the package (themes.json)
    Tests/HarnessKitTests/
      Fixtures/          generated JSON from shared/fixtures (committed)
      Support/           Fixture loader, jsonEqual
  Tools/                 bun tests for the ios/ config (config.test.ts)
```

Generated and ignored: `ios/Harness.xcodeproj`, `ios/Harness/Info.plist` (XcodeGen writes both
from project.yml), `ios/build/`, `HarnessKit/.build/`.

Sources are folder-globbed on both sides (XcodeGen `sources: Harness`, SwiftPM target paths),
so adding a file never means editing project.yml or Package.swift.

## Module boundaries

- **HarnessKit is Foundation only.** Don't import UIKit, SwiftUI, or Observation-dependent UI
  frameworks. (`Observation` itself is fine, since `@Observable` lives there.) This keeps
  `swift test` running on the macOS host in seconds, which matters for agent loops. Anything
  testable without a screen goes here: parsing, formatting, board rules, reducers, paging,
  draft logic, the client.
- **The app target is SwiftUI.** Views, navigation, platform glue (Keychain, camera, haptics,
  WKWebView) and bridges from HarnessKit values to SwiftUI types (`Color(css:)`). If a view has
  a branch worth testing, move that branch into HarnessKit.
- **I/O goes through seams.** HTTP goes through `HTTPTransport`, and the WebSocket goes through an
  injectable connection factory and sleep, so tests never open sockets or wait on real timers.
  `URLSessionTransport` is the real transport.

## Swift conventions

- Swift 6 language mode with complete strict concurrency. Deployment targets are iOS 26.0 and
  macOS 15 (package tests only).
- Model types are `Codable, Sendable, Equatable` structs. Type names match the TS names, and
  property names match the JSON keys.
- Open enums: string unions decode unknown values to `.unknown(String)`, and unknown event kinds,
  message types and transcript content decode to an `.unknown` case that keeps the raw JSON. A newer
  service must never make an older app throw.
- Timestamps are epoch milliseconds as `Double`, as in JS (`Date(timeIntervalSince1970: ms / 1000)`
  at the edge).
- Field shapes (Protocol/Patch.swift):
  - `?: T` → `T?`, omitted when nil.
  - `T | null` → `@Nullable var x: T?`, which always encodes and writes `null` for nil.
  - `?: T | null` → `Patch<T>` (`.absent`, `.null`, `.value`), where absent is omitted and null is
    written. PATCH bodies use this, so "leave it alone" and "clear it" stay distinct.
  - Maps with nullable values (`models`, `prompts`) are `[String: String?]`.
- Open enums conform to `OpenEnum` (Protocol/OpenEnum.swift). They list `allKnown` in TS order, and
  a test checks that against every member of the TS union.
- JavaScript string semantics: TS regexes without `u`, `.length`, `trim()` and `toLowerCase()`
  work on code units, so ports compare and split on `unicodeScalars` (not Characters), count
  UTF-16 where TS uses `.length`, and use `JSCompat` (Logic/Themes/JSCompat.swift) for `trim`,
  `\s`, `Math.round` and number formatting. Fixture cases with combining marks, NBSP/NEL and
  emoji pin each of these.
- Free-form JSON (`unknown` in TS) is `JSONValue`.
- Errors from the service are `HarnessAPIError(status, message, data)`. `data` stays raw JSON, so
  a 404 from getTicket can be decoded as `RemoteKeyMatches`.
- State types that views observe are `@Observable` classes on the main actor. `HarnessClient` is a
  `final class: Sendable` with only immutable state, so URL helpers stay synchronous and requests
  run in parallel. `HarnessSocket` is an actor that exposes `events`/`status` as `AsyncStream`s, and
  its status fires on transitions only. Neither touches UI state.
- Bundled resources use `.process("Resources")`. `.copy` keeps a nested `Resources/` folder,
  which codesign rejects in an iOS resource bundle. Load them with
  `Bundle.module.url(forResource:withExtension:)`, with no subdirectory.
- Comments use `///` for API docs. Follow the TS source's comment density, and keep its doc
  comments when porting.
- Tests use Swift Testing (`@Test`, `#expect`). A test must be able to fail: test branches,
  boundaries and error paths, not literals against themselves.

## Fixture pipeline (TS ↔ Swift parity)

Logic ported from `shared/` or `mobile/src/lib` must not drift from TypeScript. It's checked with
fixtures whose expected outputs come from the real TS functions:

1. **Case files:** `shared/fixtures/cases/<module>.ts`. Each named export is a JSON-able value,
   usually a case list built with `cases(fn, inputs)` or `asyncCases` from
   `shared/fixtures/case.ts`: `[{ name, input, output }]`, where `output = fn(input)`. `undefined`
   outputs are written as `null`. Files are discovered by directory, so adding one needs no
   registry edit, and parallel tickets don't conflict.
2. **Resources:** `shared/fixtures/resources/<name>.ts` → `HarnessKit/Sources/HarnessKit/Resources/<name>.json`,
   bundled data the app uses at runtime (the themes registry, project colors, icon paths). Load it
   with `Bundle.module`.
3. **Export:** `bun shared/scripts/export-fixtures.ts` writes
   `ios/HarnessKit/Tests/HarnessKitTests/Fixtures/<module>.json` (and the resources) as
   `{ "<export>": value }`, and deletes orphaned JSON. The JSON is committed.
4. **Freshness:** `shared/src/fixtures.test.ts` (part of `bun run test`) rebuilds everything in
   memory and fails if the committed JSON is stale or orphaned. Change TS behavior without
   regenerating, and `bun run test` fails. Regenerate with a behavior Swift disagrees with, and
   `swift test` fails.
5. **Swift side:** `Fixture.cases("<module>", "<export>", input: I.self, output: O.self)` feeds
   `@Test(arguments:)`. `Fixture.value` and `Fixture.exports` read arbitrary exports.
   `jsonEqual` compares JSON key-order-insensitively. Worked example:
   `shared/fixtures/cases/pairing.ts` → `Logic/Pairing.swift` → `Tests/.../Logic/PairingTests.swift`.

The protocol drift guard works the same way: `cases/protocol.ts` has a typed sample for every
entity and event, and `ProtocolRoundTripTests` decodes and re-encodes every sample, failing on any
export it has no Swift type for. When you add a field to protocol.ts, add it to a sample, and the
Swift side has to follow.

When porting a module: write the case file from the TS source and its `*.test.ts` (plus extra edge
cases), export, port, and test against the fixtures. Hand-written Swift tests are only for things
fixtures can't express (request sequences, timing).

## Accessibility labels and sim-check

`mobile/scripts/sim-check.ts` drives the app through the accessibility tree (AXe) and deep links
(`harness://pair?…`, `harness://board`, `harness://search`, `harness://ticket/<key>?tab=…`,
`harness://new[?projectId=]`, `harness://prompt/<id>`, `harness://projects`,
`harness://settings?darkTheme=…`). Visible labels and `accessibilityLabel`s that sim-check looks
for must match the RN app's exactly (e.g. "Message the agent…", "Reset to built-in",
"Image phone.png", "Prompt"), and the same deep links must route to the same screens. Then
sim-check can become the native app's parity test. When a screen is ported, grep sim-check for
its strings and keep them.

## Parity checklist

Tick these off as later tickets land them. The RN source for each is in parentheses.

- [x] Project skeleton, Info.plist parity, icon and launch screen (app.json)
- [x] Protocol types + round-trip drift guard (shared/src/protocol.ts)
- [x] HarnessClient REST + HarnessSocket WebSocket (shared/src/client.ts)
- [x] Pairing link (shared/src/pairing.ts)
- [x] Keys, file links, branches, permissions, watchers, command line, project colors (shared/src/*.ts)
- [x] Pair/manual entry parsing, saved servers, connection probe (mobile/src/lib/pair, servers, connection)
- [x] Themes registry, color math, project key colors (shared/src/themes)
- [ ] State: reducer, paging, models, format, drafts, conductor, markdown, branches (shared/src/state)
- [ ] Connect / Pair / Scan QR (app/connect, app/pair, app/scan; screens/Connect, Scan)
- [ ] Saved servers + Keychain token storage (lib/storage, lib/servers)
- [ ] Connection banner + reconnect (screens/ConnectionBanner)
- [ ] Board: columns, cards, child dimming/rollups, moves, paging (screens/Board, TicketCard, lib/boardColumns, boardLoader)
- [ ] Search tab (app/(tabs)/search)
- [ ] Ticket detail: header, details, related tickets, settings (screens/TicketDetail, ui/TicketSettings, RelatedTickets)
- [ ] Transcript + composer + mentions + slash commands (screens/Transcript, ui/mentions, lib/mentionCaret)
- [ ] Summaries + attachments viewer (ui/Attachments, lib/attachments)
- [ ] Approvals, human review, reopen, complete (screens/Approval, lib/approve)
- [ ] Agents tab / sub-agents (screens/AgentsTab)
- [ ] Browser tab (screens/BrowserTab, lib/browserInput)
- [ ] Plugin tabs in WKWebView (screens/PluginTab, lib/pluginHost)
- [ ] File viewer + diffs + syntax highlighting (screens/FileViewer, lib/fileViewer, highlight)
- [ ] New session: project, driver/model, branch picker, drafts (screens/NewSession, ui/BranchPicker, DriverModelPicker, lib/newSession, draftSync)
- [ ] Inbox + triage item detail (screens/Inbox, app/inbox/[id])
- [ ] Watchers form (screens/WatcherForm, lib/watcherDraft)
- [ ] Projects + project settings (screens/Projects, ProjectSettings)
- [ ] Prompts list + editor (screens/Prompts, app/prompt/[id])
- [ ] Settings: appearance, themes, network, drivers, permissions (screens/Settings, lib/themePicker, prefs)
- [ ] Deep links (app/+native-intent)
- [ ] sim-check passes against the native build
- [ ] Release pipeline switched to ios/ (publish-install.sh, testflight.ts), mobile/ deleted
