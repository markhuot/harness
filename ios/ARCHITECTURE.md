# Native iOS app: architecture and conventions

The iPhone and iPad app is SwiftUI. Version 2.0 replaced the 1.x React Native app, at feature
parity with it (§ Parity table). It talks to the service over the same HTTP API and WebSocket as
the desktop (DESIGN.md § HTTP API, § Network). `shared/` is the spec for everything the app shares
with the desktop, through generated fixtures. For logic only the phone has, which used to live in
the React Native app's TypeScript, the frozen fixtures (§ Fixture pipeline) are the spec, and
`swift test` owns them. The app follows the desktop's behavior, not its look. Use native SwiftUI
patterns (NavigationStack, `.sheet`, `Menu`, `.searchable`,
swipe actions, drag and drop). iPhone is the primary target. The build is universal: at regular width (iPad) the shell is a
desktop-style split view (§ App shell, iPad layout); at compact width (iPhone, and an iPad in a
narrow Split View window) it's the phone layout.

## Layout

```
ios/
  project.yml            XcodeGen spec (source of truth for the app target and Info.plist)
  Harness/               the app target: SwiftUI only (views, navigation, SwiftUI bridges)
    HarnessApp.swift     @main App: creates AppModel, Router, ToastCenter, Actions (§ App shell)
    App/                 RootView + MainTabs (the sections; DesktopShell at regular width), Destinations (Route → screen), KeychainStorage, Actions
    Features/<Area>/     one file per feature slot (§ Feature slots), plus Connect/Pair/Scan
    UI/                  the kit: badges, buttons, callouts, toasts, haptics, icons, banners
    Resources/           Assets.xcassets (AppIcon, LaunchBackground, SplashIcon)
    Theme/               Palette (theme tokens as Colors), Color(css:) and other bridges
  HarnessKit/            Swift package: everything that doesn't draw
    Sources/HarnessKit/
      Protocol/          Codable ports of shared/src/protocol.ts
      Client/            HarnessClient (REST), HarnessSocket (WebSocket), HTTPTransport seam
      Logic/             pure helpers: ports of shared/ and the phone-only rules around them
      State/             board state: BoardState + reducer, paging, selectors, the shared/src/state
                         ports and phone-only logic around them, and the @MainActor stores (BoardStore,
                         BoardLoader, DetailFetcher, DraftSync, ModelListCache)
      Shell/             DeepLink (harness:// → Route), Router, AppModel (servers, pairing, prefs)
      Resources/         generated JSON bundled with the package (themes.json)
    Tests/HarnessKitTests/
      Fixtures/          JSON from shared/fixtures, generated or frozen (committed)
      Support/           Fixture loader, jsonEqual
    Sources/HarnessHighlight/  Shiki-in-JavaScriptCore highlighter (§ Syntax highlighting)
  Tools/                 build.ts, sim.ts, sim-check.ts, dev-sim.ts + axe.ts (README § Dev loop),
                         build-highlighter.ts + highlighter/ (§ Syntax highlighting), bun tests
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
  emoji pin each of these. More of the same, found while porting the content helpers:
  - Swift `String ==`, `<`, `hasPrefix`, `split` and String dictionary keys use canonical
    equivalence and Characters (`"\r\n"` is one Character; é == e + U+0301). JS `===` and `<`
    compare UTF-16 code units. Compare `utf16` (or scalars) wherever TS compares or sorts strings.
  - `toLowerCase` applies Final_Sigma; Swift's `lowercased()` doesn't. Use `Mentions.JS.lowercase`
    (Logic/Mentions.swift), which also has UTF-16 `slice`/`indexOf` helpers.
  - Caret and range offsets stay UTF-16 in the Swift API (they match `NSRange`/UITextView). Swift
    can't hold a lone surrogate, so a JS split inside a surrogate pair becomes U+FFFD; fixtures
    either avoid it or export code units.
  - Regexes: Markdown.swift keeps the TS patterns on NSRegularExpression (UTF-16, like JS) but
    spells out JS meanings ICU doesn't share: `\s` as the ECMAScript whitespace set, `\d`/`\w`/`\b`
    ASCII-only, `.` as `[^\n\r  ]`, a bare `$` as `\z` (ICU's `$` also matches before a
    final newline), multiline `^` as a lookbehind on line terminators. `/i` without `u` folds
    ASCII only.
  - `Number(string)` has its own grammar (trims, empty → 0, `0x`/`0o`/`0b`, `.5`, `Infinity`);
    `toFixed(1)` rounds ties up on the binary value where `%.1f` rounds to even. See
    FileViewer.swift.
  - `JSON.stringify` writes keys in insertion order (integer-like keys first). For byte-exact JSON
    (PluginHost.buildInjection) the case file sorts keys and Swift writes them in the same order;
    `PluginHost.jsonStringify` matches JSON.stringify's escaping (U+2028/2029, `/`, numbers).
  - Lookups on plain TS object literals see `Object.prototype` (`codeLanguage("constructor")`,
    `keyPress("toString")`). Swift ports don't reproduce that, and fixtures leave those inputs out.
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
- All test files share one module, so test-only names clash across files (even `private` ones
  inside `@Test` macro expansions). Nest fixture input structs inside the `@Suite` type (or an
  extension of it), and put shared test helpers (like `sameScalars` in FileLinksTests.swift) in
  Support/ instead of redeclaring them.

## Fixture pipeline (TS ↔ Swift parity)

Logic ported from `shared/` must not drift from TypeScript. It's checked with fixtures whose
expected outputs come from the real TS functions. Logic that only the phone has (it lived in the
1.x React Native app's TypeScript, which is gone) is pinned by frozen fixtures instead (step 6):

1. **Case files:** `shared/fixtures/cases/<module>.ts`. Each named export is a JSON-able value,
   usually a case list built with `cases(fn, inputs)` or `asyncCases` from
   `shared/fixtures/case.ts`: `[{ name, input, output }]`, where `output = fn(input)`. `undefined`
   outputs are written as `null`. Files are discovered by directory, so adding one needs no
   registry edit, and parallel tickets don't conflict.
2. **Resources:** `shared/fixtures/resources/<name>.ts` → `HarnessKit/Sources/HarnessKit/Resources/<name>.json`,
   bundled data the app uses at runtime (the themes registry, project colors, icon paths). Load it
   with `Bundle.module`. The exporter treats every `.json` file in
   `HarnessKit/Sources/HarnessKit/Resources/` as generated and deletes any that no resource file
   produces. Hand-written JSON resources have to live somewhere else, in a different folder with
   its own `resources:` entry.
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
6. **Frozen fixtures:** JSON whose values came from the React Native app's TypeScript and is never
   regenerated. The committed JSON is the spec. A whole frozen module is listed in `FROZEN` in
   `shared/scripts/export-fixtures.ts` and has no case file; a case file that mixes computed and
   frozen exports reads the frozen ones back with `frozen(module, key)` (`shared/fixtures/case.ts`).
   `fixtures.test.ts` checks each frozen file exists and parses. To change the behavior, edit the
   JSON and the Swift together.

The protocol drift guard works the same way: `cases/protocol.ts` has a typed sample for every
entity and event, and `ProtocolRoundTripTests` decodes and re-encodes every sample, failing on any
export it has no Swift type for. When you add a field to protocol.ts, add it to a sample, and the
Swift side has to follow.

When porting a `shared/` module: write the case file from the TS source and its `*.test.ts` (plus
extra edge cases), export, port, and test against the fixtures. Hand-written Swift tests are only for things
fixtures can't express (request sequences, timing). Stateful machines (TouchGesture, ResizeGate,
PluginHostBridge, MentionCaret, stickStep) get both: direct ports of their TS tests, and fixture
sequences (`{ events[], outputs[] }`), computed by driving the TS implementation (now frozen for
the ones whose TS was in the React Native app).
Timers become explicit timestamps or a `deadline` + `tick(now:)` API, so tests never wait.

`Fixture.value` decodes through `JSONValue`/JSONDecoder. Don't switch it back to
JSONSerialization: that silently drops a leading U+FEFF from strings (the "leading BOM" markdown
case pins this).

### Deliberate differences from TS

Ports match TS on every fixture. Where Swift can't or shouldn't follow TS, the difference is listed
here and in a doc comment:

- `Prefs.normalize` drops unknown keys and turns non-string ids into nil (TS passes both through).
  The prefs blob is local to each app, so nothing else reads the extra keys.
- `Completion.approveLabel` returns nil for an unknown completion action (TS: undefined label).
- `Related.remoteMatchesOf` decodes the 404 body as `[RelatedTicket]` and returns nil when it
  doesn't fit (TS returns it unchecked).
- `ResizeGate.take` rejects NaN, Infinity and sizes that overflow Int. `WheelCoalescer` disarms
  its deadline on flush (the React Native screen's stale `setTimeout` could fire the next batch early).
- `PluginBridge.origin(of:)` stands in for `new URL().origin` without a full WHATWG parser (no
  IPv4 shorthand, IDNA, or IPv6 re-compression).
- `patchRows` drops one scalar where JS `slice(1)` drops one code unit; line numbers past
  `Int.max` saturate.
- `ChangesPatch.parse` (the Changes tab's port of @pierre/diffs' parsePatchFiles) parses only
  git-format patches (no `diff --git` lines: no files) and doesn't split `format-patch` mailboxes.
  `ChangesViewedStore` keeps a ticket's marks as an array of pairs, not a JSON object, so their
  order (which decides the ones kept past MAX_FILES) survives Swift's JSON coding.

### Local stand-ins to dedupe

These modules ran in parallel with the board-state port (HARNESS-131), so a few names live in two
places until someone dedupes them:

- `Approve.Option` stays: it isn't a straight swap for `SelectOption` (State/SelectOptions.swift).
  It's `SelectOption<CompletionAction>`, so `value` is a typed `CompletionAction`, and `label` is
  optional because TS leaves it undefined for an action this build doesn't know (the
  "unknown action has no label" fixture pins that). `SelectOption` is the plain-string form with a
  required label. Folding them together means making `SelectOption` generic with an optional
  label, which changes its other callers.
- `Completion.ProjectInfo/TicketInfo/ParentInfo` and `ProjectKey.ProjectInfo/TicketInfo` are
  narrow input shapes (the fixture cases decode partial entities into them). Overloads take
  `Ticket`/`Project` directly. `Ticket` and `RelatedTicket` conform to `TicketKeyed` (Keys.swift).
- `formatSize` exists twice on purpose: FileViewer's ("3.0 MB") and Attachments' ("3 MB",
  promotes at 1024) behave differently in TS too.
- TS's `e instanceof Error ? e.message : String(e)` has two ports in Client/ErrorMessage.swift.
  `errorMessage` falls back to `String(describing:)` (the board loaders and model lists, whose
  tests fake errors with CustomStringConvertible), and `localizedErrorMessage` falls back to
  `localizedDescription` (screens and pickers, so a URLError reads as a sentence). Use one of
  them rather than writing a third.

## Syntax highlighting (HarnessHighlight)

Code is colored by `ios/Tools/highlighter/highlight.ts` (the 1.x React Native app's Shiki setup:
Shiki core, its JavaScript regex engine, 34 languages and 19 themes) running in JavaScriptCore, so colors match the desktop
and the Git tab exactly. The pieces:

- **Bundle:** `bun ios/Tools/build-highlighter.ts` bundles `ios/Tools/highlighter/entry.ts`, which
  imports highlight.ts, into one classic script (about 3.1 MB minified, 0.43 MB gzipped) that defines
  the `HarnessHighlighter` global. Without code splitting, Bun keeps every grammar and theme as a
  lazily evaluated module, so loading the script only parses it. The language and theme lists come
  from highlight.ts (`LANGUAGE_IDS`, `SYNTAX_THEME_IDS`), so the bundle and the fixtures can't drift.
- **Generated, not committed.** The app target's "Bundle highlighter" pre-build phase (project.yml)
  runs the script on every build and writes `highlighter.js` into Harness.app. It needs `bun` and a
  `bun install` at the repo root, and it rewrites the file only when its content changes. The phase
  can't declare its real inputs (the whole Shiki tree), so `ENABLE_USER_SCRIPT_SANDBOXING` is off for
  the app target. The tests build their own copy into `ios/build/highlighter/`
  (Tests/.../Support/HighlighterScript.swift), or use `HARNESS_HIGHLIGHTER_JS`.
- **`HarnessHighlight`** is a separate library in the HarnessKit package, so only code that
  highlights links JavaScriptCore. `actor Highlighter` owns one `JSContext` on its own serial queue
  (a custom executor) and loads the script on its first job. It provides `highlight`/`highlightDiff`
  (nil means plain), a 200-entry LRU `HighlightCache` that `cached(…)` reads synchronously, the
  60 000 UTF-16-unit limit, skipping of jobs whose task was cancelled before their turn, and
  `timings`. `PlainLines` (plainLines/reuseLines) and `HighlightColors` (gitColors/diffTints) are
  Swift ports. They're synchronous, so a view draws plain text in its first frame.
  Plain diff lines come from HarnessKit's `Diff.parseDiff`, and `HighlightLineKind` is
  `DiffLineKind`. Language ids are Shiki ids, so callers map fences and paths
  (`Code.codeLanguage`, `Diff.langForPath`) first.
- **App bridge:** `Harness/Highlight/HighlightedText.swift` turns lines into `AttributedString`
  (SF Mono 12.5, Shiki fontStyle bits, diff sign and header colors). `Highlighter.app` is the shared
  instance. The debug screen `HighlightPreviewView` opens with `-debugScreen highlight`
  (`-debugAppearance dark|light` shows one theme).
- **Diff tints are row backgrounds.** UI must draw diff add/del tints (`HighlightColors.diffTints`)
  as full-width row backgrounds that span the code block's width, not text-width. The debug
  screen's text-width tints are a shortcut and not the pattern to copy.
- **Regex JIT.** JavaScriptCore's regex JIT mis-matches some patterns that Shiki's JS engine
  generates: a trailing `// comment` in Swift or TypeScript comes out as an operator plus
  identifiers. The regex interpreter matches Oniguruma. Apps on a device get no JIT. Before its first
  JSContext, `Highlighter` sets `JSC_useRegExpJIT=false` so the simulator and the Mac behave the same
  way, and the parity fixtures are generated in a child bun with `BUN_JSC_useRegExpJIT=false`
  (ios/Tools/highlighter/runCorpus.ts). Bun itself has the bug, so `bun test` results for
  highlight.ts aren't what a phone shows for those patterns.
- **Parity:** `shared/fixtures/cases/highlight.ts` runs the corpus in `ios/Tools/highlighter/corpus.ts`
  (11 languages, light and dark themes, diffs, CRLF, emoji, unknown language and theme, the size
  boundary) through the real highlight.ts. `HighlighterTests` checks that the bundle returns the
  same tokens and colors. `wellFormed()` moves a lone high surrogate left by diffLines'
  `slice(0, 1)` sign split into the next span, since Swift strings can't hold it.

**Reducer scenarios.** Stateful pure code (the reducer, paging, sub-agent state) is pinned with
scenarios instead of single cases: `shared/fixtures/board.ts` runs real TS actions through
`reducer` and records, after each step, the outputs of selector *probes* (tickets projected to
ids) and, on the last step or when asked, the whole serialized State. `BoardScenarioTests`
decodes the actions as `BoardAction`, replays them on `BoardState`, runs the same probes and
compares JSON. A new selector needs a probe on both sides (`everyProbeIsImplemented` checks the
lists match). Keep scenario data small: the 120-ticket paging tests are scaled down to 12.

## Board state conventions

- `BoardState`, `BoardAction` and `BoardSnapshot` are the TS `State`, `Action` and `Snapshot`.
  They're renamed so app code importing both HarnessKit and SwiftUI never has to disambiguate
  `@State`. Actions are Codable in the TS shape (`{ "type": "donePage.request", … }`).
- Entity maps are Swift dictionaries, which have no insertion order. Selectors that sort in TS
  sort the same way here. Where TS leaves equal sort keys in insertion order, Swift breaks the tie
  by id. Selectors whose TS order is insertion order (`unresolvedKeys`,
  `conductorsNeedingChildren`, `ticketsForProject`) come back sorted. Fixtures avoid exact ties.
- Stateful types (BoardStore, BoardLoader, DetailFetcher, DraftSync, ModelListCache) are
  `@MainActor` classes. They take the service through protocols (`LoaderClient`, `DetailClient`,
  `BoardClient`, `DraftAPI`, and `EventSource` for the socket; HarnessClient and HarnessSocket
  conform), and their debounces, retries and polls go through the `Timers` seam
  (State/Timers.swift; `ManualTimers` in tests). Methods that start a request do their
  bookkeeping synchronously, as the TS does before its first `await`, and return the `Task`.
- BoardStore is UI-framework-free. The app shell owns one per paired service, calls `start()`,
  forwards scene phases (`sceneDidEnterBackground()`, `sceneBecameActive()`), and reads
  `state`, `epoch`, `authError` and `loadError` through Observation.

## App shell

The pieces every screen uses. They're in place, so feature tickets shouldn't change them; when a
feature needs something new here, add to it without changing what's there.

- **AppModel** (HarnessKit/Shell): `loaded`, `prefs` + `setPref(\.key, v)`,
  `servers`, `active` (server + token), `pair(address, skipProbe:)`, `activate`, `forget`, `rename`,
  `connectionNonce`, and `store`: the one `BoardStore` for the active server, rebuilt whenever the
  server, its token or the nonce changes. Storage is the Keychain (`KeychainStorage`, readable
  after first unlock) under the 1.x app's keys `harness.servers`, `harness.prefs`,
  `harness.token.<id>`, in its own service. Updating from the 1.x React Native app keeps saved
  Macs, tokens and prefs through a one-way migration: when the service has no item for a key,
  `get` reads expo-secure-store's (service `app:no-auth`, then the legacy `app`; the key's bytes as
  account and generic), copies it into this service and returns it. It never changes or deletes
  the 1.x item. Every configuration (Debug included) uses the 1.x app's bundle id,
  `com.markhuot.harness`, and so its access group. `MemoryStorage` stands in for tests. `load()` runs in `HarnessApp.init`, before the first frame.
- **Environment.** Views read `@Environment(AppModel.self)`, `@Environment(Router.self)`,
  `@Environment(BoardStore.self)` (inside the tabs and RequireStore only), `@Environment(ToastCenter.self)`,
  `@Environment(Actions.self)` and `@Environment(\.palette)`.
- **Theme.** `Palette` is the resolved theme's tokens as SwiftUI Colors (`c.bgElev`, `c.status(s)`,
  `c.tone(.red)`, `c[token]` for shadow tokens), resolved by `Themes.resolve` from prefs and the
  system appearance. RootView sets `preferredColorScheme` from Settings → Appearance (alerts,
  sheets and the keyboard follow it), `tint` = accent and the window background = `bg`. Use
  palette colors, never `Color.primary`/system grays, for anything the desktop themes.
- **Actions**: `actions.perform("Started") { try await store.client… }` plays the
  error haptic and toasts `Connection.describeError` on failure, and toasts the message on success.
  `await actions.run { … }` returns the value (nil after a failure).
- **Toasts.** `ToastCenter.show(message, kind: .error | .info)`: at most 3 at the top, errors 6 s,
  info 2.6 s, tap to dismiss, selectable text. Sheets draw their own overlay too.
- **Browser channel.** `store.subscribeBrowser(id)` / `unsubscribeBrowser(id)` /
  `sendBrowserInput(id, input)` go out on the current socket in call order (one outbox per socket,
  so a mouse down never overtakes its move). browser.frame/browser.state reach `store.onEvent`
  listeners. A socket rebuilt on foregrounding has no subscriptions and its first connect doesn't
  bump `epoch`, so it bumps `socketGeneration`: resubscribe on either (BrowserTabView keys its
  `.task(id:)` on session, epoch and generation). The REST calls that aren't on `BoardClient`
  (browserState, browserNavigate, ticketTabs, settings, prompts, watchers) use `store.api`, the
  store's client as a `HarnessClient` (UI/StoreAPI.swift). Never cast `store.client` inline.
- **Navigation.** `Router` (HarnessKit/Shell) holds `selectedTab` (the section: Board, Inbox or Settings; the app has no tab bar, the Projects sidebar switches sections), a path per section, one `sheet` and
  one `cover`. Push with `router.push(.ticket(key:tab:))`; present with
  `router.present(.newSession(projectId:key:))`; `router.showBoard()` dismisses everything and goes
  to the Board. Never keep your own `NavigationStack` inside a pushed screen. Sheets are wrapped in
  a NavigationStack with a Cancel (✕) toolbar button by `SheetHost` (Projects excepted), so a sheet
  slot sets only its title and its own toolbar items. Pushed screens go on the selected section's stack.
  `RouteScreen`/`SheetHost`/`CoverHost` (App/Destinations.swift) are the only Route → view mapping.
  The sidebar's rows are `SidebarRow` (HarnessKit/Shell): `SidebarRow.current(tab:boardProject:projectExists:)`
  is the highlighted row and `router.select(row, app:)` goes there (a board row saves the project
  filter first), tested in SidebarRowTests.
- **iPad layout.** `MainTabs` branches on `horizontalSizeClass`, never on the device idiom. At
  compact width each section's root has `SidebarToolbarItem` (the Projects sheet) and the board's
  bottom bar reads Filter, search, New session. At regular width it's `DesktopShell`: a
  `NavigationSplitView` (`.balanced`, so the sidebar sits beside the section in portrait too) with
  `ProjectsSidebar(column: true)` in the sidebar column and the selected section's stack in the
  detail, so the gear's `router.push(.project(id:))` lands there. The column's visibility is the
  `sidebarHidden` pref (remembered across launches); the system toggle hides and shows it. The
  detail gets `\.desktopShell`: `SidebarToolbarItem` draws nothing, and BoardScreen puts its
  search in the navigation bar (`.searchable(placement: .toolbar)`) and Filter and New session
  (⌘N) in the top bar's trailing group, with no bottom bar. ⌘F focuses the search field at either
  width. `harness://projects` at regular width shows the sidebar instead of a sheet (RootView
  never presents it there). A section that doesn't set its own background gets `bg` from the
  detail column, since the split view paints the system background.
- **Deep links** (HarnessKit/Shell/DeepLink.swift, tested in DeepLinkTests):

  | Link | Opens |
  | --- | --- |
  | `harness://board` (`/search` is an alias), `/inbox`, `/settings[?theme=&lightTheme=&darkTheme=]` | that section, popped to its root, modals dismissed; settings applies valid theme picks (ThemePicker.themeLinkPrefs) |
  | `harness://ticket/<key>[?tab=summaries\|transcript\|details\|children\|agents\|browser\|changes\|agent:<id>\|plugin:<p>:<t>]` | push TicketDetailScreen (an invalid tab is dropped; `plugin:git:changes` opens the built-in Changes tab) |
  | `harness://inbox/<sessionId>` | push TriageScreen |
  | `harness://file/<path>?ticket=\|project=#Lx-Ly` | push FileViewerScreen (FileViewer.fileRoute(forURL:), anchor kept) |
  | `harness://project/<id>`, `/driver/<id>`, `/prompts`, `/prompt/<id>` | push ProjectSettingsScreen, DriverSettingsScreen, PromptsScreen, PromptDetailScreen |
  | `harness://projects[?from=search]` | Projects sheet (0.6 / large detents); on iPad (regular width), shows the sidebar column |
  | `harness://new[?projectId=\|key=]`, `/watcher[?id=]`, `/connect` | New session, Watcher, Connect sheets |
  | `harness://pair?url=&token=` | Pair sheet: waits for the Keychain, pairs, goes to the Board |
  | `harness://scan` | the QR scanner (full-screen cover, over a sheet when one is up) |

- **Route guard.** Without an active server the root is ConnectScreen. Sheets that need the store
  wrap their slot in `RequireStore` (spinner until loaded, Connect without a server).
- **UI kit** (Harness/UI, in the desktop's design language): `Badge(tone:outline:icon:)`,
  `StatusDot`, `StatusPill`, `ProjectKeyBadge`, `ReviewMark`, `DriverBadge`, `KindBadge`,
  `ModelBadge`, `DepChip`, `HButton` / `.buttonStyle(.harness(.primary))` (primary, secondary,
  ghost, danger, dangerSolid; small; loading; haptic), `Card`, `Callout`, `EmptyState`
  (ContentUnavailableView), `Spinner`, `LoadingScreen`, `SectionTitle`, `RelativeTimeText` /
  `NowReader` (TimelineView at 30 s, 10 s or 1 s), `TicketKeyLabel`,
  `RelatedTicketRows`, `ProgressBar`, `ConductorRollup`, `ParentCrumb`, `ConnectionBanner` (put it
  in a tab root's `.safeAreaInset(edge: .top)`), `Icon("name")` (every shared icon name maps to an
  SF Symbol, Icons.symbols in HarnessKit, checked by a test), `haptic(.success)`,
  `.confirmation($item)` / `.choiceSheet($item)`, `DraftField` (commits on
  return or blur). Also `FlowLayout` (wrapping rows, leading or trailing),
  `.primaryToolbarItem(c)` (prominent only when the theme's onAccent is
  white), `PickerLatest`, `String.nilIfEmpty` and `deviceName`. Settings-style screens are plain `Form` + `LabeledContent`.

## Feature slots

Each later feature ticket owns the files listed for it: it replaces the placeholder body (keeping
the initializer, which RouteScreen/SheetHost and other slots already call) and adds new files next
to it in the same folder. It doesn't edit another area's files, App/, UI/ or HarnessKit/Shell. If
a signature has to change, change its call sites in the same commit and say so in the summary.
Shared helpers a feature needs go in a new file under its own folder (or a new HarnessKit file).

**Shared folders: prefix new files, and keep type names unique.** Some folders hold slots for
several tickets that run in parallel. `Ticket/` is shared by Ticket detail, Transcript + Agents,
and Browser + Plugin tabs. A new file in a shared folder starts with its area's prefix
(`TicketDetail*.swift`, `Transcript*.swift`, `Agents*.swift`, `Browser*.swift`, `Plugin*.swift`),
so two tickets never create the same file. Every new type name must be unique across the app
target, because it's one module and a clash only shows up when the branches merge. Prefix types
the same way (`TranscriptRow`, `BrowserToolbar`), or nest them inside your slot's type.

| Slot | File (ios/Harness/Features/…) | Area | Signature |
| --- | --- | --- | --- |
| BoardScreen | Board/BoardScreen.swift | Board + search | `BoardScreen()` |
| ProjectsSheet | Board/ProjectsSheet.swift | Projects | `ProjectsSheet()`, and `ProjectsSidebar(column:)` it wraps (the iPad's sidebar column) |
| TicketDetailScreen | Ticket/TicketDetailScreen.swift | Ticket detail | `TicketDetailScreen(key: String, initialTab: TicketTab?)` |
| TranscriptView | Ticket/TranscriptView.swift | Transcript | `TranscriptView(sessionId: String, subagentId: String? = nil, emptyHint: String? = nil) { header }` (header optional) |
| AgentsTabView | Ticket/AgentsTabView.swift | Agents | `AgentsTabView(ticket: Ticket)` |
| SubagentView | Ticket/SubagentView.swift | Agents | `SubagentView(ticket: Ticket, subagentId: String)` |
| BrowserTabView | Ticket/BrowserTabView.swift | Browser | `BrowserTabView(ticket: Ticket)` |
| PluginTabView | Ticket/PluginTabView.swift | Plugin tabs | `PluginTabView(ticket: Ticket, tab: PluginTab)` |
| InboxScreen | Inbox/InboxScreen.swift | Inbox | `InboxScreen()` |
| TriageScreen | Inbox/TriageScreen.swift | Inbox | `TriageScreen(sessionId: String)` |
| SettingsScreen | Settings/SettingsScreen.swift | Settings | `SettingsScreen()` (placeholder already has Macs + appearance; keep both) |
| DriverSettingsScreen | Settings/DriverSettingsScreen.swift | Settings | `DriverSettingsScreen(driverId: String)` (HARNESS-145, port of main's HARNESS-157) |
| ProjectSettingsScreen | Settings/ProjectSettingsScreen.swift | Projects | `ProjectSettingsScreen(projectId: String)` |
| PromptsScreen | Prompts/PromptsScreen.swift | Prompts | `PromptsScreen()` |
| PromptDetailScreen | Prompts/PromptDetailScreen.swift | Prompts | `PromptDetailScreen(id: String)` |
| WatcherFormScreen | Watchers/WatcherFormScreen.swift | Watchers | `WatcherFormScreen(id: String?)` |
| NewSessionScreen | NewSession/NewSessionScreen.swift | New session | `NewSessionScreen(projectId: String?, key: String?)` |
| FileViewerScreen | Files/FileViewerScreen.swift | File viewer | `FileViewerScreen(params: FileRouteParams)` |
| MarkdownView | Content/MarkdownView.swift | Markdown | `MarkdownView(text:, size: = 15, color: = nil, linkContext: = FileLinkContext())` |
| CodeBlockView | Content/CodeBlockView.swift | Markdown / File viewer | `CodeBlockView(code:, language: = nil, showLineNumbers: = false, highlightLines: ClosedRange<Int>? = nil)` |
| AttachmentRow | Content/AttachmentRow.swift | Summaries & attachments | `AttachmentRow(attachments: [SummaryAttachment])` |
| DriverModelPicker | Pickers/DriverModelPicker.swift | Pickers | `DriverModelPicker(value:, resolved:, title:, defaultLabel:, onlyDriver:, disabled:, inheritedModel:, onChange:)` (Watchers.TriageChoice) |
| ModelPicker | Pickers/ModelPicker.swift | Pickers | `ModelPicker(driver:, value:, inherited:, defaultLabel:, plainDefault:, title:, disabled:, onChange: (String?) -> Void)` |
| PermissionPicker | Pickers/PermissionPicker.swift | Pickers | `PermissionPicker(value: PermissionMode?, inherited:, disabled:, onChange:)` |
| BranchPicker | Pickers/BranchPicker.swift | Pickers | `BranchPicker(projectId:, value:, defaultLabel:, newLabel:, title:, disabled:, onChange: (String?, BranchInfo?) -> Void)` |
| ProjectColorPicker | Pickers/ProjectColorPicker.swift | Projects | `ProjectColorPicker(value: String?, onChange:)` |
| MentionTextEditor | Pickers/MentionTextEditor.swift | Transcript / New session | `MentionTextEditor(text: Binding<String>, placeholder:, projectId:, ticketKey:, minHeight:, commandDriver:, commands:, maxLines:, suggestionsEdge:, suggestionsMaxHeight:, boxed:, search:, searchCommands:, fieldLabel:, placeholderColor:, onFocusChange:, fieldBox:)` (all after `text` optional) |
| TicketSettingsForm | Pickers/TicketSettingsForm.swift | Ticket detail | `TicketSettingsForm(ticket: Ticket, branches: TicketBranches? = nil, onPatch: (UpdateTicketBody) -> Void)` |

Done in the shell (not slots): ConnectScreen, PairScreen and ScanScreen (Features/Connect). The
board's decisions that don't draw (landing column, card menu and AX label, drop positions) are in
HarnessKit's `BoardScreenRules`. The shared parameters a slot needs come from the
environment (store, router, palette), not from extra initializer arguments.

The ticket detail screen fetches its plugin tabs with `.pluginTabs(for: ticket, into: $tabs)`
(Ticket/PluginTabsLoader.swift: nil until loaded, [] on failure, refetched on
workdir/branch/epoch) and hosts each in `PluginTabView`. DEBUG builds also open either tab on its
own with `-debugScreen browser:<KEY>` or `-debugScreen plugin:<KEY>:<pluginId>:<tabId>`
(BrowserPluginDebugScreen; the plugin one adds a probe of the bridge messages the page receives).
dev-sim installs a Release build, so build with `SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG` to
get them there.

## Ticket detail (Features/Ticket/TicketDetail*)

TicketDetailScreen (HARNESS-139) hosts the other Ticket slots as tab bodies. What a tab body gets
from it (Ticket/TicketDetailSupport.swift):

- **`.ticketHeroScroll()`** on a tab body's ScrollView or List: its drags and flings hide the hero
  and bring it back (HarnessKit `HeroCollapse`, checked against frozen fixtures).
  TranscriptView and AgentsTabView should attach it, since sim-check `--stick` checks the hero on
  the Transcript. Outside a ticket screen it does nothing.
- **`.ticketStickToBottom()`** on a ScrollView whose newest content is last (Summaries, and the
  Transcript): it opens at the bottom, follows new content while pinned, stays put once the user
  scrolls up and re-pins at the bottom (StickToBottom.stickStep, fed by scroll phases).
- **`@Environment(\.ticketDetailOpenTab)`** opens a tab on the hosting screen, which is how the
  Agents list and the Transcript's sub-agent rows open `Tabs.subagentTabRoute(id)`, and how a
  sub-agent's Back returns to `.agents`. A tab change also brings the hero back.
- The composer sits in the screen's bottom `safeAreaInset`, so tab bodies shouldn't add their own.
  Its field's AX label is always "Message the agent" (MentionTextEditor `fieldLabel`).
- Testable branches (menus, the Complete sheet's rules, run rows, labels) are in HarnessKit's
  `TicketDetailLogic`. Approve/Complete menus are native `Menu`s; sim-check closes one with
  "Dismiss context menu".

## Transcript, Agents and Inbox (Ticket/Transcript*, Ticket/Agents*, Inbox/)

What HARNESS-140 settled:

- **Decisions live in HarnessKit** (tested): `TranscriptLogic` (rows, the delta and "Working…"
  rows, which entries draw nothing, the sub-agent a tool call started, tool state, permission
  footer, the window), `InboxLogic` (watcher order, Retry now, triage badge and outcome, link
  context) and `AgentsLogic` (sections, previews, marks, row labels).
- **The transcript is a windowed plain `VStack`, not a `LazyVStack`.** A lazy stack re-estimates
  the rows it hasn't measured as they scroll by, so its content height jumps by hundreds of points
  mid-fling and the bottom can't be held. It draws the newest `TranscriptLogic.windowStep` (150)
  rows; "Show earlier messages (N)" adds 150 more and scrolls back to the row the user was reading.
  `groupTranscript` reruns only when the entries change (TranscriptItemsMemo), rows are Equatable
  so a delta re-renders only the rows it touched, and MarkdownCache keeps parses across renders.
- **Scroll metrics.** SwiftUI's `ScrollGeometry.containerSize` is the frame *less* the content
  insets, so `ScrollMetrics(contentOffsetY:…)` adds the insets to the viewport as well as the
  content. Under the composer's inset the end of the list used to read as 90-122 pt from the
  bottom, and a fling's bounce back off the end unpinned it.
- **Sub-agent links.** The tool row that started a sub-agent, an Agents row and the sub-agent
  breadcrumb open tabs through `\.ticketDetailOpenTab`; outside a ticket screen (triage) there
  are no links.
- **Not checked on screen:** thinking blocks (the dummy driver never emits one) and inline tool
  output images.

## Changes tab (Ticket/Changes*)

Changes is built in (HARNESS-153), not the git plugin's page in a WebView:

- **Data** comes through HarnessKit's `ChangesSource`. Until the service has a core Changes API,
  `PluginChangesSource` reads the git plugin's `/plugins/git/api/{changes,log,file}`; a core API is
  one more conformance, swapped in where ChangesTabView builds its `ChangesStore`.
- **Tabs.** `Tabs` stays a fixture-checked port of shared/src/state/tabs.ts. `ChangesTab` sits on
  top: `plugin:git:changes` normalizes to `changes`, git:changes is filtered out of the plugin
  tabs, and the tab shows only when the service lists the git plugin's tab (the plugin is enabled
  and its `when: "workdir"` holds, or a diff was pinned before the worktree went away).
  Until the plugin tabs load it falls back to "has a workdir". It goes after Browser, ahead of
  Details, with the listed tab's icon (the plugin's `branch` by default).
- **Decisions live in HarnessKit** (tested): `ChangesStore` (refresh queueing, a 600 ms debounce on
  ticket events, a 4 s poll while the ticket is busy and the tab is on screen, viewed marks and
  collapse toggles, context expansion from `/file?side=new`), `ChangesRows` (rows, gaps, split
  pairing, highlight source, copy), `ChangesPatch` and `ChangesViewedStore` (fixture parity with
  @pierre/diffs and plugins/git/ui/viewed.ts, so a file changed again after viewing reads as
  unviewed). Marks and the Unified/Split choice are in UserDefaults; split shows unified below
  560 pt but keeps the choice.
- **Drawing.** One `LazyVStack` of rows (overview, file list, each file's header, gaps, lines), so
  long diffs stay lazy. Lines wrap instead of scrolling sideways; add/del tints are full-width row
  backgrounds. Each file is highlighted as one diff job (`ChangesHighlights`), keyed by its rows and
  the theme.

## Content components (Features/Content)

What screens that show agent text use (HARNESS-136):

- **MarkdownView** parses through `MarkdownCache` (bounded, by source text), so re-rendering a long
  transcript doesn't re-parse every message. Ticket keys link only when `ticketLinkable` (it reads
  the store when one is in the environment). `MarkdownView.scrollsSideways(text)`
  says whether a bubble needs a definite width: tables and code scroll sideways.
  Tables lay out with `MarkdownTableLayout` on HarnessKit's `MarkdownTable` (columns capped at
  240 pt).
- **Links.** Screens set where relative file links open with `.fileLinkScope(ticketKey:)`,
  `.fileLinkScope(projectId:)` or `.fileLinkScope(FileViewer.triageLinkContext(…))`; MarkdownView's `linkContext` argument wins when it names a root. Where a link
  goes is `LinkRouting.target` (HarnessKit, tested): other schemes open in the system, harness://
  links that aren't files go through the Router, file links push `.file`, and a file link with no
  root toasts. `ContentLinkOpener` is the same opener for links outside markdown.
- **CodeBlockView** takes a fence tag or a Shiki id; long-press → Copy copies the whole block.
- **AttachmentRow** presents `AttachmentViewer` itself (a clear fullScreenCover that fades in).
  `AttachmentMedia` caches images and video posters for the row and the viewer. The pager is
  `AttachmentPager`, a UIKit paging UIScrollView whose pages
  are UIHostingControllers of the SwiftUI page views, given the store and palette explicitly. A
  page-style TabView lost sideways swipes that started over AVPlayerViewController's view, so the
  viewer often couldn't page off a video; inside the scroll view, its pan sees them first. Paging is
  off while an image is zoomed. A page keeps one view for its whole life, so video pages keep one
  AVPlayerViewController and only hand it a player while showing. Labels match sim-check `--attachments`: "Image x.png" /
  "Video x.mp4" thumbnails, "Close", "2 of 4 · 1.2 MB".
- **Debug gallery:** a paired Debug build launched with `-debugScreen content [-debugTicket KEY]`
  shows sample markdown and that ticket's summaries with their attachments.

## Pickers and form controls (Features/Pickers)

What the hosting screens (Ticket detail, New session, Settings, Project settings, Watchers) get:

- **Selects.** `SelectMenu` is the app's select: a `Menu` of checkmark Toggles (subtitles,
  disabled rows, an actions section headed by the problem line) whose trigger, `SelectTrigger`,
  shows the value in the accent color with a spinner, a warning or the ⌃⌄ glyph. ModelPicker and
  PermissionPicker are built on it. DriverModelPicker and BranchPicker use the same trigger, but
  open a `PickerSheet`. That sheet draws its own header (Cancel, the title and an accessory) instead
  of toolbar items, because AXe doesn't see a sheet's toolbar and sim-check taps "Cancel" by label.
- **Model lists** come from `store.sharedModelCache`, one `ModelListCache` per store
  (PickerClient.swift). `store.pickerClient` is the store's client as a `PickerClient`
  (model lists, branches, files and commands; HarnessClient conforms).
- **Rows.** Put a picker in `TicketSettingsRow(label:hint:) { control } footer: { … }`, not
  `LabeledContent`. LabeledContent merges the label and the control into one AX element ("Model,
  Model, Default (…)"), and a tap aimed at that element's center misses the trigger.
- **TicketSettingsForm** renders bare rows for a `Form` `Section`. New session, which also needs
  the branch hint (to open Options), passes its own `TicketBranches` and attaches
  `.trackingBranches(branches, for: draft)` to its screen.
- **Stale closures.** A TextField's `onSubmit` (and focus-change handlers) can fire with a closure
  from an earlier render, which captured that render's ticket, value and callbacks. Read
  `@State`, or a `PickerLatest` box set in `body`, at fire time. Never read a captured `let`.
- **The debug gallery.** `-debugScreen pickers [-debugSection selects|model|branch|color|mentions|settings|draft]`
  opens PickerGalleryView in a build with the DEBUG condition. It needs a paired service; dev-sim's
  GREET project works. `bun ios/Tools/build.ts sim` builds Release, which leaves it out, so build
  with `SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG` added to that xcodebuild line.

## Settings screens (Features/Settings, Prompts, Watchers)

What Settings, Project settings, the watcher form and Prompts share (HARNESS-144):

- **Decisions live in HarnessKit's `SettingsRules`** (tested): listen labels and the localhost
  confirm, what a committed max-runs or base-branch field saves, driver status and login labels,
  watcher row lines, the identifier draft, rename toast and Remove project copy.
- **Rows.** `SettingsRow(label:hint:)` puts the hint under the label and the control, so a long
  hint never squeezes a picker to "…" (TicketSettingsRow keeps the hint beside the label, which
  only suits short hints). `SettingsButtonRow` is a tappable row; `SettingsSectionHeader` is a
  header with a trailing icon button ("Add watcher", "Refresh drivers").
- **No modifiers on a Form `Section`.** SwiftUI applies them to every row of the section, so
  Settings' sections set `SettingsModel`'s `menu` / `confirm` / `textPrompt` and the screen
  presents them, and it runs the network, drivers and prompt-catalog loads once.
- **AXe and segmented Pickers.** AXe lists a segmented Picker as one unlabeled element, so a
  segment sim-check taps or waits for ("Compare with built-in") is a labeled Button
  (PromptSegmented). Lazy Forms leave off-screen rows out of the AX tree too; the Prompts list is a
  plain stack because sim-check waits for a row below the fold.
- **The prompt editor** is a UIKit bridge (`PromptTextEditor`): a growing UITextView with
  autocorrection and smart punctuation off, whose selection `PromptEditorHandle` keeps (UTF-16, as
  `Prompts.insertText` takes it) and which scrolls its enclosing scroll view to keep the caret
  above the keyboard.

## New session (Features/NewSession)

- **Decisions live in HarnessKit's `NewSessionEditor`** (tested): when the editor can start (the
  reopened draft, or composerProject's pick), the predicted key until the first save, what the
  store's copy of the saved draft means (another device's edit adopted only without unsent edits,
  discarded, launched), the project switch (branch picks reset, a Default model follows), the
  submit gate and Cancel's step. It wraps `DraftSync`; the screen feeds it `store.state` through
  `.onChange` and acts on what it returns.
- **Its own Cancel.** SheetHost leaves the shell's ✕ off this sheet; the screen's asks Save draft /
  Discard draft / Keep editing for a non-empty draft. A swipe down (any `onDisappear`) saves.
- The prompt is a MentionTextEditor with `fieldLabel: "Prompt"` (sim-check looks for it) and `autofocus`.

## File viewer (Features/Files)

- **Decisions live in HarnessKit:** `FileViewerRules` holds the title, subtitle, badges, meta line,
  Diff counts, body and diff states, error copy and Copy link. `FileHighlightWindows` is the 40k-char
  window around what's on screen, and the colored lines it piles up. `FileViewerLoader` loads the
  file, then the diff when git says the file is dirty. It drops stale loads and splits the lines and
  patch rows off the main actor. All of these have tests.
- **`FileCodeList`** is a UICollectionView with a fixed-row layout (19 pt rows, one scroll view
  for both directions, pull to refresh). It opens straight at a row and reports the visible rows.
  Rows are `FileCodeRow` columns of NSAttributedString. A code label is only as wide as its text,
  because a UILabel's backing store covers its whole frame. Bump `version` to redraw the rows on
  screen. Prefetching is off, so no stale cell survives a bump. Line numbers are hidden from AX.
  The code label's AX label is its text and its value is "Line N", so sim-check can find
  `export function greetingFor…`.
- **Scroll benchmark:** in a build with the DEBUG condition, launch with `-fileViewerBench YES`
  and open a file over 1000 lines. Two seconds later the list scrolls to the bottom at 6000 pt/s,
  then logs `file-bench: …` (category `file-bench`) with frame times and the cost per cell. On the
  shared simulator, a 20 001-line TypeScript file logged 3795 frames, every one 16.7 ms, with 0
  hitches and 61 µs per cell, and colors kept up the whole way.
- File/Diff is two labeled buttons, not a segmented Picker, because sim-check taps the label that
  starts with "Diff". The counts use `Text(verbatim:)`, so 25000 doesn't render as "25,000".

## Disk budget (parallel agents)

Several tickets build at once on a Mac with little free disk. CLAUDE.md → Simulators has the rules;
for this app they come down to:

- Test only on iOS 27.0. Never download a runtime or create a simulator.
- Use the shared `harness-shared` simulator through `bun run sim with-lock -- …`. dev-sim and
  sim-check take the lock themselves.
- Build with `-derivedDataPath ios/build/dd` inside your own worktree and nowhere else.
- Run `bun run sim disk` before any `xcodebuild`, and block and ask when it exits 1.
- When you finish, delete `ios/build` and `ios/HarnessKit/.build`. Leave the simulator alone.

## Accessibility labels and sim-check (read this before porting a screen)

**sim-check finds everything by AXLabel**: the visible text of an element, or its
`accessibilityLabel`. `ios/Tools/sim-check.ts` drives the app through the accessibility tree
(AXe) and deep links. The rule for every screen:

- Wherever sim-check looks for a label, the UI exposes **exactly** that label. Grep
  sim-check.ts for the screen's strings before you port it and keep every one: column chips
  "Planning, 3" (`"<Status>, <count>"`), card labels starting "GREET-1 <title>", "Options" /
  "Options, …", "Cancel", "Allow once", "Start work", "Message the agent…", "Reset to built-in",
  "Customize", "Image phone.png", "Prompt", "Model, …", "Agent review: skipped", "Remote ID JIRA-62"…
- A composite control whose label sim-check reads (a card, a chip) uses
  `.accessibilityElement(children: .ignore)` + `.accessibilityLabel(…)`, so AXe sees one element
  with the whole string instead of its pieces.
- The root AX element must stay the app ("Harness"), so no full-screen overlay may take
  accessibility focus above the window.
- Don't label a container whose children sim-check taps (`.accessibilityElement(children:
  .contain)` plus `.accessibilityLabel`): AXe then lists the container as one element and drops
  its rows. That's why the mention list and the project color swatches have no group label.
- Every route in § App shell is reachable by a `harness://` link (the same links the 1.x app
  took, so old links keep working), with the same semantics (a tab link pops to the tab root and dismisses modals; a ticket link pushes).

`bun ios/Tools/sim-check.ts --only=<screen>` checks one screen on the shared simulator. A change
to a screen should keep that screen's `--only=` entries passing.

## Parity table

This is the historical parity audit against the 1.x React Native app, which has since been deleted;
the "RN file" column names files from that app. HARNESS-145 audited every file in its routes,
screens, UI kit, lib and state against `main` as of the HARNESS-155/157/160 merges: each
user-visible feature, action, state, empty state, error, haptic, deep link and persistence key,
read on both sides and checked in the simulator where sim-check reaches it. Logic rows are also
pinned by fixtures (§ Fixture pipeline). Every row is done. "Differs" notes a deliberate,
native-pattern difference, not a missing feature.

| Feature | RN file | Swift file | Status |
| --- | --- | --- | --- |
| Keychain load before the first frame; one store per server + nonce | app/_layout, state/app, state/store | HarnessApp, Shell/AppModel, State/BoardStore | done |
| Storage keys `harness.servers`, `harness.prefs`, `harness.token.<id>` (after first unlock) | lib/storage, lib/servers, lib/prefs | App/KeychainStorage, Shell/AppModel, Logic/Prefs | done (one-way migration of the RN app's items) |
| Sections Board / Inbox / Settings, switched from the Projects sidebar (no tab bar) | app/(tabs)/_layout | App/RootView | done (differs: RN has a tab bar) |
| Theme: color scheme, accent tint, bg, nav title colors | state/app, app/_layout | App/RootView, App/BarAppearance, Theme/Palette | done |
| Actions + toasts (3 max, 6 s / 2.6 s) + haptics + pick/confirm | state/store useAction, ui/Toasts, ui/haptics, ui/pick | App/Actions, UI/Toasts, UI/Haptics, UI/Confirm | done (menus are native `Menu`s; differs) |
| UI kit: badges, buttons, cards, callouts, empty states, conductor rollups, parent crumb, related rows | ui/kit, ui/Conductor, ui/RelatedTickets | UI/* | done |
| Connect: Scan, saved Macs, manual entry, Keychain footer, "Token rejected", pairing sheet | screens/Connect, app/connect, app/pair | Features/Connect/ConnectScreen | done |
| Scan QR (permission, Open Settings, recheck on return, dedupe, haptics) | screens/Scan | Features/Connect/ScanScreen | done |
| Connection banner (re-pair on 401, reconnecting + load error) | screens/ConnectionBanner | UI/ConnectionBanner | done |
| Board: columns as pages, status chips "Status, n", landing column, swipe haptic | screens/Board, lib/boardColumns | Features/Board/BoardScreen, BoardColumnView, HarnessKit BoardScreenRules | done |
| Board header: title, sidebar (Projects); bottom bar: Filter (Show child tickets), search field, + New session (iPad: search in the navigation bar, Filter and New session top trailing, ⌘F / ⌘N) | screens/Board, ui/header | BoardScreen | done (differs) |
| Done paging, autofill, "Couldn't load older tickets. Retry", empty states, pull to refresh | screens/Board, lib/boardLoader | BoardColumnView, State/BoardLoader | done |
| Cards: badges, review marks, blocked/approval lines, rollups, dep chips, driver/model names, dimmed children, drafts | screens/TicketCard | BoardTicketCard, UI/Badges (ModelBadge) | done |
| Card menu (titled "KEY · title"): moves, top/bottom, open parent, copy key, discard draft; VoiceOver actions | screens/TicketCard | BoardTicketCard, BoardScreenRules | done (plus drag and drop, native only) |
| Search: the board's always-visible field, status line, Retry, jump to results | app/(tabs)/search, screens/Board | BoardScreen | done |
| Projects sheet (the sidebar, its header button badged with triaging or busy sessions): Inbox row (same badge), All projects, rows, settings gear, Add project, Settings at the bottom; on iPad a split view's sidebar column, hidden and shown by its toggle | screens/Projects | Features/Board/ProjectsSheet (ProjectsSidebar), ProjectsAdd, App/RootView DesktopShell, HarnessKit SidebarRow | done |
| Ticket screen: load, renamed key, not found, draft → New session, Remote ID list | screens/TicketDetail | Features/Ticket/TicketDetailScreen | done |
| Header menu: Copy key, Open external, Cancel run, Open PR, Mark done, Delete | screens/TicketDetail | TicketDetailScreen | done |
| Hero: crumb, title (compact on Browser/plugin/sub-agent), badges incl. model name and PR | screens/TicketDetail | TicketDetailHero | done |
| Start work, Approve (+ menu incl. clean up), Request changes, Complete (+ menu), agent review, Re-open, Cancel run | screens/TicketDetail, lib/approve, shared/completion | TicketDetailHero, TicketDetailSheets, HarnessKit Approve/Completion/TicketDetailLogic | done |
| Conductor-managed children: Approve/Complete disabled with the reason; on-base tickets offer no merge/PR | screens/TicketDetail (HARNESS-155/160) | TicketDetailHero, Completion.managingConductor/worksOnBase | done |
| Hero collapse on scroll, back on tab change, news or a status-bar tap | ui/heroCollapse, lib/heroCollapse | TicketDetailSupport, HarnessKit HeroCollapse | done |
| Tab strip: order, counts, live dots, plugin icons, sub-agent highlights Agents | screens/TicketDetail, shared/state/tabs | TicketDetailTabStrip, HarnessKit Tabs/ChangesTab | done |
| Summaries: brief/plan, depends-on chips, empty state, attachments, stick to bottom | screens/TicketTabs | TicketDetailSummariesTab | done |
| Tickets (children) tab: progress, waiting count, groups, rows with chips | screens/TicketTabs | TicketDetailChildrenTab | done |
| Details: title, brief (Unsaved/Revert/Save), ticket settings, links, runs, related | screens/TicketTabs, ui/TicketSettings | TicketDetailDetailsTab, Pickers/TicketSettingsForm | done |
| Approval card: Allow once, Deny…, Always allow; announced to VoiceOver | screens/Approval | TicketDetailApprovalCard | done |
| Composer: placeholder by status, move switch while writing, @files, /commands, Send | screens/TicketDetail, ui/mentions, lib/mentionCaret | TicketDetailComposer, Pickers/MentionTextEditor | done |
| Transcript: rows, deltas, Working…, thinking, tools (images, sub-agent links), permissions, errors, stick to bottom | screens/Transcript | TranscriptView, TranscriptRows, TranscriptToolRow, HarnessKit TranscriptLogic | done (windowed, "Show earlier messages (N)": native only) |
| Agents & tasks tab: sub-agents and background tasks (Bash, Monitor) in one list, latest update first, with type chips; sub-agent view (Back to Agents & tasks, breadcrumbs, task, transcript); task output view (command, output polled every second and following the bottom, notes, result); tool rows link with "Open transcript" / "Open output" | — (native only) | AgentsTabView, SubagentView, TaskOutputView, HarnessKit AgentsLogic/Subagents (`taskOutputs`) | done |
| Browser tab: toolbar, frames, touch/wheel/drag input, keyboard, resize gate | screens/BrowserTab, lib/browserInput | BrowserTabView, BrowserTabModel, BrowserInputViews | done |
| Plugin tabs in a web view with the host bridge and theme | screens/PluginTab, lib/pluginHost | PluginTabView, PluginWebHost, PluginTabsLoader | done |
| Changes tab (the git plugin's page) | plugins/git/ui | ChangesTabView, ChangesRowViews, HarnessKit ChangesStore/ChangesRows/ChangesPatch | done (native; file paths open the file viewer: native only) |
| Inbox: watcher strip, Retry now, error expand, sessions, Inbox zero | screens/Inbox | Features/Inbox/InboxScreen, HarnessKit InboxLogic | done |
| Triage item: outcome, Open KEY, transcript, file-link scope | screens/Inbox, app/inbox/[id] | TriageScreen | done |
| New session: project, kind, prompt (@, /), Options, Start/Plan first, drafts, Cancel choices | screens/NewSession, lib/newSession, lib/draftSync | Features/NewSession/NewSessionScreen, HarnessKit NewSessionEditor/DraftSync | done (Cancel asks with an alert; differs) |
| Pickers: selects, model, permission, driver+model sheet, branch sheet, project color | ui/selects, ui/DriverModelPicker, ui/BranchPicker, ui/ProjectColor, lib/modelSheet | Features/Pickers/* | done |
| File viewer: header, menu, File/Diff, ranges, windowed colors, errors, pull to refresh | screens/FileViewer, lib/fileViewer | Features/Files/*, HarnessKit FileViewerRules/FileViewerLoader | done |
| Markdown, code blocks, file links + scope, attachments row and viewer | ui/Markdown, ui/CodeBlock, ui/fileLinks, ui/Attachments, lib/attachments | Features/Content/* | done (code copies by long-press; differs) |
| Syntax highlighting | lib/highlight | HarnessHighlight, Highlight/HighlightedText | done |
| Settings: Macs (Connect, Rename, Forget, Rotate token), network, appearance + themes | screens/Settings, lib/themePicker | Features/Settings/SettingsScreen, SettingsAppearance | done |
| Settings: drivers (each opens its screen) + default model, general, permissions, triage | screens/Settings (HARNESS-157) | SettingsServiceSections | done |
| Driver screen: status, Log in, review model, Anthropic API key | screens/DriverSettings, app/driver/[id] | Features/Settings/DriverSettingsScreen | done |
| Settings: prompts summary, watchers (menu, enable), projects | screens/Settings | SettingsListSections | done |
| Project settings: identifier rename preview, color, folder, agents, completion, Remove | screens/ProjectSettings | ProjectSettingsScreen | done |
| Prompts list and editor (Customize, Reset, Compare, variables) | screens/Prompts, app/prompt/[id] | Features/Prompts/* | done |
| Watcher form | screens/WatcherForm, lib/watcherDraft | Features/Watchers/WatcherFormScreen | done |
| Deep links (every `harness://` route above) | app/+native-intent, expo-router routes | Shell/DeepLink, Router, App/Destinations | done |
| Not ported (RN-only platform glue) | lib/keyboard, lib/device, ui/KeyboardAvoider | SwiftUI keyboard avoidance, UIDevice | n/a |

Release builds carry no placeholders or debug routes: every `-debugScreen` gallery, the file
viewer bench, the plugin probe and HighlightPreviewView are inside `#if DEBUG`, and Release
defines no DEBUG condition.

## Manual checks (HARNESS-145 results)

Checked on the shared simulator (iOS 27.0) unless marked **device**:

- **Board card push → Back:** passes in every full interaction run. Back is tapped by label when
  AXe sees it, else at the header point sim-check's `tapHeader` uses.
- **Robustness (a scripted pass with real daemons):**
  - Daemon restart: the "Reconnecting to …" banner shows, then clears, and a ticket made after
    the restart arrives live (4 of 5 runs; once the live event didn't arrive within 20 s,
    though the banner cleared).
  - Token rotation shows the red re-pair banner, and re-pairing clears it.
  - Two Macs paired, switching between them from Connect.
  - Cold launch from `harness://ticket/<key>?tab=details`.
  - Backgrounding to Settings.app: a ticket made meanwhile shows on return.
  - Dynamic Type at AX5 on the board, ticket, Settings and New session.
- **Keychain migration:** the Release build installed over a paired 1.x React Native app comes up
  with that app's saved Mac.
- **Transcript rows the dummy driver can't produce** (seeded straight into the service's
  database):
  - A thinking row expands and collapses.
  - A tool result with an inline base64 PNG shows the image in the expanded row.
  - 604 entries: "Show earlier messages (460)" → (310) keeps the row being read in place.
- **Large boards:** `--paging` (125+ done tickets) passes. The Done column loads 50 a page, so a
  bigger history only adds pages.
- **Device only (simctl and AXe can't do these):**
  - Board drag and drop with a real touch.
  - The chip-jump haptics.
  - Rotating on the Browser tab (ResizeGate).
  - Long-press-then-drag on the Browser tab.
  - Smoothness (frame times) of a long transcript fling.
  - Switching between two plugin tabs: this repo's only plugin tab is git:changes, which is now
    built in.
- **`--keyboard`** passes (4/4 native). A headless simulator (no Simulator.app) always has a
  hardware keyboard attached, which minimizes the software keyboard to a bar. That holds whatever
  the host's `ConnectHardwareKeyboard` says, and after a reboot too. So sim-check turns the
  simulated device's own `AutomaticMinimizationEnabled` (com.apple.keyboard.preferences) off for
  the run and puts it back afterwards, so no other simulator changes. It types by tapping the
  on-screen keys, because AXe's `type` and `key` are hardware key events, which put iOS back in
  hardware-keyboard mode.
