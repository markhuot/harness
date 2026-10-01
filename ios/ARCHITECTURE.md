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
    HarnessApp.swift     @main App: creates AppModel, Router, ToastCenter, Actions (§ App shell)
    App/                 RootView + MainTabs, Destinations (Route → screen), KeychainStorage, Actions
    Features/<Area>/     one file per feature slot (§ Feature slots), plus Connect/Pair/Scan
    UI/                  the kit: badges, buttons, callouts, toasts, haptics, icons, banners
    Resources/           Assets.xcassets (AppIcon, LaunchBackground, SplashIcon)
    Theme/               Palette (theme tokens as Colors), Color(css:) and other bridges
  HarnessKit/            Swift package: everything that doesn't draw
    Sources/HarnessKit/
      Protocol/          Codable ports of shared/src/protocol.ts
      Client/            HarnessClient (REST), HarnessSocket (WebSocket), HTTPTransport seam
      Logic/             pure helpers ported from shared/ and mobile/src/lib
      State/             board state: BoardState + reducer, paging, selectors, the shared/src/state
                         and mobile/src/lib ports around it, and the @MainActor stores (BoardStore,
                         BoardLoader, DetailFetcher, DraftSync, ModelListCache)
      Shell/             DeepLink (harness:// → Route), Router, AppModel (servers, pairing, prefs)
      Resources/         generated JSON bundled with the package (themes.json)
    Tests/HarnessKitTests/
      Fixtures/          generated JSON from shared/fixtures (committed)
      Support/           Fixture loader, jsonEqual
    Sources/HarnessHighlight/  Shiki-in-JavaScriptCore highlighter (§ Syntax highlighting)
  Tools/                 build.ts, dev-sim.ts + axe.ts (README § Dev loop), build-highlighter.ts, bun tests
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

Logic ported from `shared/` or `mobile/src/lib` must not drift from TypeScript. It's checked with
fixtures whose expected outputs come from the real TS functions:

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

The protocol drift guard works the same way: `cases/protocol.ts` has a typed sample for every
entity and event, and `ProtocolRoundTripTests` decodes and re-encodes every sample, failing on any
export it has no Swift type for. When you add a field to protocol.ts, add it to a sample, and the
Swift side has to follow.

When porting a module: write the case file from the TS source and its `*.test.ts` (plus extra edge
cases), export, port, and test against the fixtures. Hand-written Swift tests are only for things
fixtures can't express (request sequences, timing). Stateful machines (TouchGesture, ResizeGate,
PluginHostBridge, MentionCaret, stickStep) get both: direct ports of their TS tests, and fixture
sequences (`{ events[], outputs[] }`) that the case file computes by driving the TS implementation.
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
  its deadline on flush (the RN screen's stale `setTimeout` can fire the next batch early).
- `PluginBridge.origin(of:)` stands in for `new URL().origin` without a full WHATWG parser (no
  IPv4 shorthand, IDNA, or IPv6 re-compression).
- `patchRows` drops one scalar where JS `slice(1)` drops one code unit; line numbers past
  `Int.max` saturate.

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

## Syntax highlighting (HarnessHighlight)

Code is colored by the RN app's own `mobile/src/lib/highlight.ts` (Shiki core, its JavaScript regex
engine, the same 34 languages and 19 themes) running in JavaScriptCore, so colors match the desktop
and the Git tab exactly. The pieces:

- **Bundle:** `bun ios/Tools/build-highlighter.ts` bundles `ios/Tools/highlighter/entry.ts`, which
  imports highlight.ts, into one classic script (about 3.1 MB minified, 0.43 MB gzipped) that defines
  the `HarnessHighlighter` global. Without code splitting, Bun keeps every grammar and theme as a
  lazily evaluated module, so loading the script only parses it. The language and theme lists come
  from highlight.ts (`LANGUAGE_IDS`, `SYNTAX_THEME_IDS`), so the two apps can't drift.
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

- **AppModel** (HarnessKit/Shell, port of state/app.tsx): `loaded`, `prefs` + `setPref(\.key, v)`,
  `servers`, `active` (server + token), `pair(address, skipProbe:)`, `activate`, `forget`, `rename`,
  `connectionNonce`, and `store`: the one `BoardStore` for the active server, rebuilt whenever the
  server, its token or the nonce changes (RN's `<StoreProvider key={id:nonce}>`). Storage is the
  Keychain (`KeychainStorage`, readable after first unlock) under the RN keys `harness.servers`,
  `harness.prefs`, `harness.token.<id>`, in its own service, so the two apps don't share pairings.
  `MemoryStorage` stands in for tests. `load()` runs in `HarnessApp.init`, before the first frame.
- **Environment.** Views read `@Environment(AppModel.self)`, `@Environment(Router.self)`,
  `@Environment(BoardStore.self)` (inside the tabs and RequireStore only), `@Environment(ToastCenter.self)`,
  `@Environment(Actions.self)` and `@Environment(\.palette)`.
- **Theme.** `Palette` is the resolved theme's tokens as SwiftUI Colors (`c.bgElev`, `c.status(s)`,
  `c.tone(.red)`, `c[token]` for shadow tokens), resolved by `Themes.resolve` from prefs and the
  system appearance. RootView sets `preferredColorScheme` from Settings → Appearance (alerts,
  sheets and the keyboard follow it), `tint` = accent and the window background = `bg`. Use
  palette colors, never `Color.primary`/system grays, for anything the desktop themes.
- **Actions** (RN `useAction`): `actions.perform("Started") { try await store.client… }` plays the
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
  (browserState, browserNavigate, ticketTabs) use `store.client as? HarnessClient`.
- **Navigation.** `Router` (HarnessKit/Shell) holds `selectedTab`, a path per tab, one `sheet` and
  one `cover`. Push with `router.push(.ticket(key:tab:))`; present with
  `router.present(.newSession(projectId:key:))`; `router.showBoard()` dismisses everything and goes
  to the Board. Never keep your own `NavigationStack` inside a pushed screen. Sheets are wrapped in
  a NavigationStack with a Cancel (✕) toolbar button by `SheetHost` (Projects excepted), so a sheet
  slot sets only its title and its own toolbar items. Pushed screens go on the selected tab's stack.
  `RouteScreen`/`SheetHost`/`CoverHost` (App/Destinations.swift) are the only Route → view mapping.
- **Deep links** (HarnessKit/Shell/DeepLink.swift, tested in DeepLinkTests):

  | Link | Opens |
  | --- | --- |
  | `harness://board`, `/search`, `/inbox`, `/settings[?theme=&lightTheme=&darkTheme=]` | that tab, popped to its root, modals dismissed; settings applies valid theme picks (ThemePicker.themeLinkPrefs) |
  | `harness://ticket/<key>[?tab=summaries\|transcript\|details\|children\|agents\|browser\|agent:<id>\|plugin:<p>:<t>]` | push TicketDetailScreen (an invalid tab is dropped) |
  | `harness://inbox/<sessionId>` | push TriageScreen |
  | `harness://file/<path>?ticket=\|project=#Lx-Ly` | push FileViewerScreen (FileViewer.fileRoute(forURL:), anchor kept) |
  | `harness://project/<id>`, `/prompts`, `/prompt/<id>` | push ProjectSettingsScreen, PromptsScreen, PromptDetailScreen |
  | `harness://projects[?from=search]` | Projects sheet (0.6 / large detents) |
  | `harness://new[?projectId=\|key=]`, `/watcher[?id=]`, `/connect` | New session, Watcher, Connect sheets |
  | `harness://pair?url=&token=` | Pair sheet: waits for the Keychain, pairs, goes to the Board |
  | `harness://scan` | the QR scanner (full-screen cover, over a sheet when one is up) |

- **Route guard.** Without an active server the root is ConnectScreen. Sheets that need the store
  wrap their slot in `RequireStore` (spinner until loaded, Connect without a server).
- **UI kit** (Harness/UI, ports of ui/kit.tsx and friends): `Badge(tone:outline:icon:)`,
  `StatusDot`, `StatusPill`, `ProjectKeyBadge`, `ReviewMark`, `DriverBadge`, `KindBadge`,
  `ModelBadge`, `DepChip`, `HButton` / `.buttonStyle(.harness(.primary))` (primary, secondary,
  ghost, danger, dangerSolid; small; loading; haptic), `Card`, `Callout`, `EmptyState`
  (ContentUnavailableView), `Spinner`, `LoadingScreen`, `SectionTitle`, `RelativeTimeText` /
  `NowReader` (TimelineView at 30 s, 10 s or 1 s, as RN's useNow), `TicketKeyLabel`,
  `RelatedTicketRows`, `ProgressBar`, `ConductorRollup`, `ParentCrumb`, `ConnectionBanner` (put it
  in a tab root's `.safeAreaInset(edge: .top)`), `Icon("name")` (every shared icon name maps to an
  SF Symbol, Icons.symbols in HarnessKit, checked by a test), `haptic(.success)`,
  `.confirmation($item)` / `.choiceSheet($item)` (RN confirm / pick), `DraftField` (commits on
  return or blur). Settings-style screens are plain `Form` + `LabeledContent`.

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
| BoardScreen | Board/BoardScreen.swift | Board + Search | `BoardScreen(mode: BoardMode)` (`.board`, `.search`) |
| ProjectsSheet | Board/ProjectsSheet.swift | Projects | `ProjectsSheet(fromSearch: Bool)` |
| TicketDetailScreen | Ticket/TicketDetailScreen.swift | Ticket detail | `TicketDetailScreen(key: String, initialTab: TicketTab?)` |
| TranscriptView | Ticket/TranscriptView.swift | Transcript | `TranscriptView(sessionId: String, subagentId: String? = nil)` |
| AgentsTabView | Ticket/AgentsTabView.swift | Agents | `AgentsTabView(ticket: Ticket)` |
| SubagentView | Ticket/SubagentView.swift | Agents | `SubagentView(ticket: Ticket, subagentId: String)` |
| BrowserTabView | Ticket/BrowserTabView.swift | Browser | `BrowserTabView(ticket: Ticket)` |
| PluginTabView | Ticket/PluginTabView.swift | Plugin tabs | `PluginTabView(ticket: Ticket, tab: PluginTab)` |
| InboxScreen | Inbox/InboxScreen.swift | Inbox | `InboxScreen()` |
| TriageScreen | Inbox/TriageScreen.swift | Inbox | `TriageScreen(sessionId: String)` |
| SettingsScreen | Settings/SettingsScreen.swift | Settings | `SettingsScreen()` (placeholder already has Macs + appearance; keep both) |
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
| MentionTextEditor | Pickers/MentionTextEditor.swift | Transcript / New session | `MentionTextEditor(text: Binding<String>, placeholder:, projectId:, ticketKey:, minHeight:, commandDriver:, commands:, maxLines:, suggestionsEdge:, suggestionsMaxHeight:, boxed:, search:, searchCommands:)` (all after `text` optional) |
| TicketSettingsForm | Pickers/TicketSettingsForm.swift | Ticket detail | `TicketSettingsForm(ticket: Ticket, branches: TicketBranches? = nil, onPatch: (UpdateTicketBody) -> Void)` |

Done in the shell (not slots): ConnectScreen, PairScreen and ScanScreen (Features/Connect). The
board's decisions that don't draw (landing column, card menu and AX label, drop positions) are in
HarnessKit's `BoardScreenRules`. The shared parameters a slot needs come from the
environment (store, router, palette), not from extra initializer arguments.

The ticket detail screen fetches its plugin tabs with `.pluginTabs(for: ticket, into: $tabs)`
(Ticket/PluginTabsLoader.swift, RN `usePluginTabs`: nil until loaded, [] on failure, refetched on
workdir/branch/epoch) and hosts each in `PluginTabView`. Until it does, DEBUG builds open either
tab on its own with `-debugScreen browser:<KEY>` or `-debugScreen plugin:<KEY>:<pluginId>:<tabId>`
(BrowserPluginDebugScreen; the plugin one adds a probe of the bridge messages the page receives).
dev-sim installs a Release build, so build with `SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG` to
get them there.

## Content components (Features/Content)

What screens that show agent text use (HARNESS-136):

- **MarkdownView** parses through `MarkdownCache` (bounded, by source text), so re-rendering a long
  transcript doesn't re-parse every message. Ticket keys link only when `ticketLinkable` (it reads
  the store when one is in the environment). `MarkdownView.scrollsSideways(text)` (RN
  `scrollsSideways`) says whether a bubble needs a definite width: tables and code scroll sideways.
  Tables lay out with `MarkdownTableLayout` on HarnessKit's `MarkdownTable` (columns capped at
  240 pt).
- **Links.** Screens set where relative file links open with `.fileLinkScope(ticketKey:)`,
  `.fileLinkScope(projectId:)` or `.fileLinkScope(FileViewer.triageLinkContext(…))` (RN
  `FileLinkScope`); MarkdownView's `linkContext` argument wins when it names a root. Where a link
  goes is `LinkRouting.target` (HarnessKit, tested): other schemes open in the system, harness://
  links that aren't files go through the Router, file links push `.file`, and a file link with no
  root toasts. `ContentLinkOpener` is the same opener for links outside markdown.
- **CodeBlockView** takes a fence tag or a Shiki id; long-press → Copy copies the whole block.
- **AttachmentRow** presents `AttachmentViewer` itself (a clear fullScreenCover that fades in).
  `AttachmentMedia` caches images and video posters for the row and the viewer. Pager pages are a
  page-style TabView; a page must keep one view for its whole life (swapping a page's view as it
  comes and goes made the pager jump back a page), so video pages keep one AVPlayerViewController
  and only hand it a player while showing. Labels match sim-check `--attachments`: "Image x.png" /
  "Video x.mp4" thumbnails, "Close", "2 of 4 · 1.2 MB".
- **Debug gallery:** a paired Debug build launched with `-debugScreen content [-debugTicket KEY]`
  shows sample markdown and that ticket's summaries with their attachments.

## Pickers and form controls (Features/Pickers)

What the hosting screens (Ticket detail, New session, Settings, Project settings, Watchers) get:

- **Selects.** `SelectMenu` is ui/selects.tsx's `Select`: a `Menu` of checkmark Toggles (subtitles,
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
`accessibilityLabel`. `mobile/scripts/sim-check.ts` drives the app through the accessibility tree
(AXe) and deep links, and `bun mobile/scripts/sim-check.ts --native` runs it against this app. The
rule for every screen:

- Wherever sim-check looks for a label, the native UI exposes **exactly** the RN app's label. Grep
  sim-check.ts for the screen's strings before you port it and keep every one: column chips
  "Planning, 3" (`"<Status>, <count>"`), card labels starting "GREET-1 <title>", "Options" /
  "Options, …", "Cancel", "Allow once", "Start work", "Message the agent…", "Reset to built-in",
  "Customize", "Image phone.png", "Prompt", "Model, …", "Agent review: skipped", "Remote ID JIRA-62"…
- A composite control whose label sim-check reads (a card, a chip) uses
  `.accessibilityElement(children: .ignore)` + `.accessibilityLabel(…)`, so AXe sees one element
  with the whole string instead of its pieces.
- The root AX element must stay the app ("Harness"), so no full-screen overlay may take
  accessibility focus above the window.
- Every route in § App shell is reachable by the same `harness://` link as in RN, with the same
  semantics (a tab link pops to the tab root and dismisses modals; a ticket link pushes).

`bun mobile/scripts/sim-check.ts --native --only=<screen>` checks one screen on the shared
simulator. `--only=connect` passes as of HARNESS-135; each feature ticket should make
its own screens' `--only=` entries pass.

## Parity checklist

Tick these off as later tickets land them. The RN source for each is in parentheses.

- [x] Project skeleton, Info.plist parity, icon and launch screen (app.json)
- [x] Protocol types + round-trip drift guard (shared/src/protocol.ts)
- [x] HarnessClient REST + HarnessSocket WebSocket (shared/src/client.ts)
- [x] Pairing link (shared/src/pairing.ts)
- [x] Keys, file links, branches, permissions, watchers, command line, project colors (shared/src/*.ts)
- [x] Pair/manual entry parsing, saved servers, connection probe (mobile/src/lib/pair, servers, connection)
- [x] Themes registry, color math, project key colors (shared/src/themes)
- [x] State: reducer, paging, selectors, sub-agents, conductor, watcher status, format, models, drafts, branch rows (shared/src/state)
- [x] Board state I/O: BoardStore connection policy, BoardLoader, DetailFetcher, DraftSync, ModelListCache (state/store.tsx, lib/boardLoader, details, draftSync)
- [x] Board/form helpers: boardColumns, modelSheet, selectOptions, watcherDraft, newSession (mobile/src/lib)
- [x] Content helpers (HarnessKit/Logic, fixture parity), RN source in parentheses:
  - Markdown blocks/inline/plainText (state/markdown), code fences + normalizePatch (state/code),
    diff parsing (diff)
  - Mentions, slash commands, mention caret (mentions, commands, lib/mentionCaret)
  - Templates and prompts (templates, prompts)
  - Completion and approve menus/requests (completion, lib/approve)
  - Ticket tabs (state/tabs), project key rename preview (state/projectKey)
  - Attachments (state/attachments, lib/attachments), stick to bottom (state + lib/stickToBottom,
    plus a SwiftUI ScrollPhase → event mapping)
  - Plugin host bridge + injection (state/pluginBridge, lib/pluginHost), browser touch/keyboard
    input (lib/browserInput)
  - Related tickets (lib/related), file viewer routes/windows/patch rows (lib/fileViewer)
  - Prefs + v2 migration (lib/prefs), theme picker (lib/themePicker)
  - Already covered elsewhere: icons (state/icons → Themes/Icons.swift), syntax highlighting
    (lib/highlight, HARNESS-133). RN-only, not ported: lib/keyboard (works around
    KeyboardAvoidingView's parent-relative frame; SwiftUI's keyboard avoidance doesn't need it),
    lib/device and lib/storage (platform glue for the app target).
- [x] Connect / Pair / Scan QR (app/connect, app/pair, app/scan; screens/Connect, Scan)
- [x] Saved servers + Keychain token storage (lib/storage, lib/servers)
- [x] Connection banner + reconnect (screens/ConnectionBanner)
- [x] Board: columns, cards, child dimming/rollups, moves (context menu, VoiceOver actions, drag and drop), paging (screens/Board, TicketCard, lib/boardColumns, boardLoader)
- [x] Search tab (app/(tabs)/search)
- [x] Pickers and form controls: selects, model/permission/driver+model/branch/color pickers, @-mention and /command editor, ticket settings rows (ui/selects, DriverModelPicker, BranchPicker, ProjectColor, mentions, TicketSettings; lib/modelSheet, mentionCaret)
- [ ] Ticket detail: header, details, related tickets, settings (screens/TicketDetail, ui/TicketSettings, RelatedTickets)
- [ ] Transcript + composer + mentions + slash commands (screens/Transcript, ui/mentions, lib/mentionCaret)
- [x] Content components: MarkdownView, CodeBlockView, file links + scope, AttachmentRow + full-screen
  viewer (ui/Markdown, ui/CodeBlock, ui/fileLinks, ui/Attachments, lib/attachments)
- [ ] Summaries tab (screens/Summaries; renders MarkdownView + AttachmentRow)
- [ ] Approvals, human review, reopen, complete (screens/Approval, lib/approve)
- [ ] Agents tab / sub-agents (screens/AgentsTab)
- [x] Browser tab (screens/BrowserTab, lib/browserInput)
- [x] Plugin tabs in WKWebView (screens/PluginTab, lib/pluginHost)
- [x] Syntax highlighting engine: Shiki in JavaScriptCore, cache, plain/reuse lines, git tints (lib/highlight)
- [ ] File viewer + diffs (screens/FileViewer, lib/fileViewer, ui/CodeBlock)
- [ ] New session: project, driver/model, branch picker, drafts (screens/NewSession, ui/BranchPicker, DriverModelPicker, lib/newSession, draftSync)
- [ ] Inbox + triage item detail (screens/Inbox, app/inbox/[id])
- [ ] Watchers form (screens/WatcherForm, lib/watcherDraft)
- [x] Projects sheet (screens/Projects)
- [ ] Project settings (screens/ProjectSettings)
- [ ] Prompts list + editor (screens/Prompts, app/prompt/[id])
- [ ] Settings: appearance, themes, network, drivers, permissions (screens/Settings, lib/themePicker, prefs)
- [x] Deep links (app/+native-intent) and the app shell: tabs, Router, AppModel, UI kit
- [ ] sim-check passes against the native build
- [ ] Release pipeline switched to ios/ (publish-install.sh, testflight.ts), mobile/ deleted

## Manual checks for HARNESS-145

Things AXe and sim-check can't drive, to try by hand on a device:

- Board drag and drop on a real touch: a card dragged onto another card in the same column sits
  above it, one dropped on a status chip or into another column moves there, and the move sticks
  after a refresh.
- An animated chip jump (tap Done while on Planning) plays no select haptic for the pages it
  scrolls through on the way. A swipe from one column to the next plays exactly one.
