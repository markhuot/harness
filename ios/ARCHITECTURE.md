# Native iOS app: architecture and conventions

The iPhone and iPad app is SwiftUI. Version 2.0 replaced the 1.x React Native app, at feature
parity with it (§ Parity table). It talks to the service over the same HTTP API and WebSocket as
the desktop (DESIGN.md § HTTP API, § Network). `shared/` is the spec for everything the app shares
with the desktop: the wire contract tests (§ Tests) hold the Swift protocol types to
`shared/src/protocol.ts`. The app follows the desktop's behavior, not its look. Use native SwiftUI
patterns (NavigationStack, `.sheet`, `Menu`, `.searchable`,
swipe actions, drag and drop). iPhone is the primary target. The build is universal: at regular width (iPad) the shell is a
desktop-style split view (§ iPad layout); at compact width (iPhone, and an iPad in a
narrow Split View window) it's the phone layout.

## Layout

```
ios/
  project.yml            XcodeGen spec (source of truth for the app target and Info.plist)
  Harness/               the app target: SwiftUI only (views, navigation, SwiftUI bridges)
    HarnessApp.swift     @main App: creates AppModel, Actions; main and ticket WindowGroups, each window with its own Router (§ Windows)
    App/                 RootView + MainTabs (the sections; DesktopShell at regular width), Destinations (Route → screen), KeychainStorage, Actions
    Features/<Area>/     one file per feature slot (§ Feature slots), plus Connect/Pair/Scan
    UI/                  the kit: badges, buttons, callouts, haptics, icons, banners
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
    Sources/HarnessHighlight/  Shiki-in-JavaScriptCore highlighter (§ Syntax highlighting)
  Tools/                 build.ts, sim.ts, dev-sim.ts + axe.ts (README § Dev loop),
                         build-highlighter.ts + highlighter/ (§ Syntax highlighting)
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

## Tests

All of the app's tests live in the top-level `testing/` directory (its README describes each layer);
`bun run testing` runs them and a change doesn't land until it passes. Nothing under `ios/` holds a
test.

- **Logic** (`testing/swift`, `bun run testing l0`): a Swift package of its own that tests
  HarnessKit through its public API on the Mac host, in seconds. When you port a `shared/` module,
  write the Swift test from the TS behavior and its edge cases. Stateful machines take explicit
  timestamps or a `deadline` + `tick(now:)` API, so tests never wait.
- **Wire contract** (`testing/contract`): samples of every type and constant in
  `shared/src/protocol.ts`, generated with the TypeScript checker, which the Swift types must
  decode and re-encode unchanged. When you add a field to protocol.ts, the Swift side has to
  follow.
- **The shared world** (`testing/world`): one typed set of data the screens are drawn from.
  `WorldDecodeTests` decodes all of it through the real HarnessKit models.
- **Screens** (`testing/ios`, `bun run testing ios`): § Screen tests.
- **The walkthrough** (`bun run testing walk`): one journey through the real service, Mac app,
  iPhone and iPad.
- **Themes resource.** `Resources/themes.json` (the theme registry, project colors and icon paths)
  is generated from `shared/src` by `bun shared/scripts/export-themes.ts` and loaded with
  `Bundle.module`; a test fails when the committed file is stale. Don't switch its decoding to
  JSONSerialization: that silently drops a leading U+FEFF from strings.

### Deliberate differences from TS

Ports match TS. Where Swift can't or shouldn't follow TS, the difference is listed
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
  optional because TS leaves it undefined for an action this build doesn't know (an
  unknown action has no label). `SelectOption` is the plain-string form with a
  required label. Folding them together means making `SelectOption` generic with an optional
  label, which changes its other callers.
- `Completion.ProjectInfo/TicketInfo/ParentInfo` and `ProjectKey.ProjectInfo/TicketInfo` are
  narrow input shapes (they decode partial entities). Overloads take
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
  way, and Bun itself has the bug, so bun results for
  highlight.ts aren't what a phone shows for those patterns.
## Board state conventions

- `BoardState`, `BoardAction` and `BoardSnapshot` are the TS `State`, `Action` and `Snapshot`.
  They're renamed so app code importing both HarnessKit and SwiftUI never has to disambiguate
  `@State`. Actions are Codable in the TS shape (`{ "type": "donePage.request", … }`).
- Entity maps are Swift dictionaries, which have no insertion order. Selectors that sort in TS
  sort the same way here. Where TS leaves equal sort keys in insertion order, Swift breaks the tie
  by id. Selectors whose TS order is insertion order (`unresolvedKeys`,
  `conductorsNeedingChildren`, `ticketsForProject`) come back sorted. Tests avoid exact ties.
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
  `@Environment(BoardStore.self)` (inside the tabs and RequireStore only),
  `@Environment(Actions.self)` and `@Environment(\.palette)`.
- **Theme.** `Palette` is the resolved theme's tokens as SwiftUI Colors (`c.bgElev`, `c.status(s)`,
  `c.tone(.red)`, `c[token]` for shadow tokens), resolved by `Themes.resolve` from prefs and the
  system appearance. RootView sets `preferredColorScheme` from Settings → Appearance (alerts,
  sheets and the keyboard follow it), `tint` = accent and the window background = `bg`. Use
  palette colors, never `Color.primary`/system grays, for anything the desktop themes.
- **Actions**: `actions.perform { try await store.client… }` plays the error haptic on failure.
  `await actions.run { … }` returns the value (nil after a failure).
- **No toasts.** The app posts no toasts or banners over the screen: they covered the back and
  close buttons. A success shows in the screen itself (the board and ticket update over the
  socket). A failure, or an input the app can't take, plays the error haptic (warning for a limit).
  Anything the person has to read, like a driver login's device code, goes in an alert or inline.
- **Browser channel.** `store.subscribeBrowser(id)` / `unsubscribeBrowser(id)` /
  `sendBrowserInput(id, input)` go out on the current socket in call order (one outbox per socket,
  so a mouse down never overtakes its move). browser.frame/browser.state reach `store.onEvent`
  listeners. Foregrounding always rebuilds the socket (a suspended app hears no events, and a
  dropped socket can still look open), and its first connect bumps `epoch` like a reconnect, so
  views refetch what changed meanwhile. A rebuilt socket also has no subscriptions, so it bumps
  `socketGeneration` the moment it's made: resubscribe on either (BrowserTabView keys its
  `.task(id:)` on session, epoch and generation). The REST calls that aren't on `BoardClient`
  (browserState, browserNavigate, ticketTabs, settings, prompts, watchers) use `store.api`, the
  store's client as a `HarnessClient` (UI/StoreAPI.swift). Never cast `store.client` inline.
- **Browser tabs.** A session's browser can have several tabs; a socket watches one per session.
  `subscribeBrowser(id, tabId:)` picks it (nil: the lowest open tab; again with another id
  switches), `sendBrowserInput(id, tabId:, input)` aims one input at a tab (nil: the watched one;
  `.closeTab` needs it), and `.newTab(url:)` opens a tab and moves the socket there. The service
  moves a socket by itself (newTab, closing the watched tab), so HarnessSocket follows each
  browser.state's `tabId` and resubscribes to that tab after a reconnect. BrowserTabModel keeps the
  shown tab in HarnessKit's `BrowserTabSelection` across resubscribes of the same session: it drops
  the frame when the tab changes, ignores frames from other tabs (in flight after a switch), and
  supplies the strip (every tab, even a lone one, so it can be torn off) and chip labels. Services from before tabs send no ids:
  nothing is filtered, the strip never shows and New tab is disabled.
- **Navigation.** `Router` (HarnessKit/Shell, one per window: § Windows) holds `selectedTab` (the section: Board, Inbox or Settings; the app has no tab bar, the Projects sidebar switches sections), a path per section, one `sheet` and
  one `cover`. Push with `router.push(.ticket(key:tab:))`; present with
  `router.present(.newSession(projectId:key:))`; `router.showBoard()` dismisses everything and goes
  to the Board. Never keep your own `NavigationStack` inside a pushed screen. Sheets are wrapped in
  a NavigationStack with a Cancel (✕) toolbar button by `SheetHost` (Projects excepted), so a sheet
  slot sets only its title and its own toolbar items. Pushed screens go on the selected section's stack.
  `RouteScreen`/`SheetHost`/`CoverHost` (App/Destinations.swift) are the only Route → view mapping.
  The sidebar's rows are `SidebarRow` (HarnessKit/Shell): `SidebarRow.current(tab:board:)` (the
  board from `BoardState.boardFilter(prefs.boardProject)`) is the highlighted row and
  `router.select(row, app:)` goes there (a board row saves its filter first: a project id, or a
  group's `Paging.groupScope(name)`), tested in SidebarRowTests. A ticket screen leaves the stack through
  `router.removeTicket(where:)` and swaps itself with `router.replaceTicket(_:with:)`, never by
  editing `path(router.selectedTab)`, so the same code works as a ticket window's root.
- **iPad layout:** see § iPad layout and § Windows.
- **Deep links** (HarnessKit/Shell/DeepLink.swift, tested in DeepLinkTests):

  | Link | Opens |
  | --- | --- |
  | `harness://board` (`/search` is an alias), `/inbox`, `/settings[?theme=&lightTheme=&darkTheme=]` | that section, popped to its root, modals dismissed; settings applies valid theme picks (ThemePicker.themeLinkPrefs) |
  | `harness://ticket/<key>[?tab=spec\|activity\|transcript\|details\|children\|agents\|browser\|changes\|agent:<id>\|plugin:<p>:<t>]` | push TicketDetailScreen (an invalid tab is dropped, and an old `summaries` opens spec; `plugin:git:changes` opens the built-in Changes tab); on iPad at regular width, open or bring forward that ticket's window (§ Windows) |
  | `harness://inbox/<sessionId>` | push TriageScreen |
  | `harness://file/<path>?ticket=\|project=#Lx-Ly` | a file card in the dock (TicketSheet.Root.file; a ticket window pushes FileViewerScreen) (FileViewer.fileRoute(forURL:), anchor kept) |
  | `harness://project/<id>`, `/driver/<id>`, `/prompts`, `/prompt/<id>`, `/extensions` | push ProjectSettingsScreen, DriverSettingsScreen, PromptsScreen, PromptDetailScreen, ExtensionSettingsScreen |
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
  return or blur), `.keyboardOverlapPadding()` (a form in the iPhone's ticket sheet, whose safe
  area doesn't include the keyboard, pads its bottom by the keyboard's overlap). Also `FlowLayout` (wrapping rows, leading or trailing),
  `.primaryToolbarItem(c)` (prominent only when the theme's onAccent is
  white), `PickerLatest`, `String.nilIfEmpty` and `deviceName`. Settings-style screens are plain `Form` + `LabeledContent`.

## iPad layout

`MainTabs` branches on `horizontalSizeClass`, never on the device idiom. At compact width each section's root has `SidebarToolbarItem` (the Projects sheet); the board
hides its navigation bar and uses the system's bottom bar (`.bottomBar` toolbar items, on every phone and the iPad): Projects, the command palette (a magnifier button that presents the palette sheet, `SheetRoute.palette`; a toolbar item can't be a wide field), New session. The palette
(`Features/Palette/PaletteScreen`, rules in HarnessKit `Palette`/`PaletteRows`) is the Mac's ⌘K:
plain text finds tickets (the board loader's search, so one request) and commands, `>` limits it
to commands (and "Go to" rows, never tickets or files), `#` to tickets, `@` (⌘P, "Open file…") to
the focused ticket's, else the board's project's, files, opened in the file viewer. With a ticket
sheet open it lists that ticket's actions (`TicketActions.set`, run by a `TicketActionRunner` the
palette owns), Copy ticket key and Open in source tracker. "Show/Hide child tickets" lives here;
the board no longer filters by a search (that's the Mac's). At regular width it's `DesktopShell`: a
`NavigationSplitView` (`.balanced`, so the sidebar sits beside the section in portrait too) with
`ProjectsSidebar(column: true)` in the sidebar column and the selected section's stack in the
detail, so the gear's `router.push(.project(id:))` lands there. The column's visibility is the
`sidebarHidden` pref (remembered across launches); the system toggle hides and shows it. The
detail gets `\.desktopShell`: `SidebarToolbarItem` draws nothing, and BoardScreen puts its
a Command palette button and New session in the top bar's trailing group, with no bottom bar.
⌘F and ⌘K open the palette at either width (⌘K and ⌘P are also registered in the ticket sheet
host, where the window's chords don't fire).

**Keyboard shortcuts** (App/KeyCommands.swift, whose header has the reasons) follow the desktop's
⌘ chords (keys.ts) at either width. iOS keeps the first registration of a chord, so the
window-wide ones are hidden buttons at each window's root from its first frame (`WindowShortcuts`
in SceneChrome): New Session ⌘N, All Projects ⌘1, Inbox ⌘2, Settings ⌘,, and Next/Previous Tab
⇧⌘]/⇧⌘[, which step the ticket screen on top (it registers with `ShortcutTargets` as it appears,
`Tabs.nextTab`). ⌃⌘S is a hidden button in MainTabs (the Projects sheet, which closes itself on
⌃⌘S) and DesktopShell (the `sidebarHidden` pref). ⌘↩ on a field sharing its screen (composer,
Details spec, approval Deny note) is `.onSubmitShortcut`, a key press on the focused field; a
sheet's primary button carries `.submitShortcut()` (New session's Start, with ⇧⌘↩ on Plan first;
Request changes, Re-open, Approve and…, the annotator's Add). ⌘S saves a prompt, and sheets'
Cancel buttons take Esc (`.cancelAction`). Not SwiftUI `Commands`: their menu commands don't fire
on iPhone and iOS takes ⌘, for itself. `harness://projects` at regular width shows the sidebar instead of a sheet (RootView
never presents it there). A section that doesn't set its own background gets `bg` from the
detail column, since the split view paints the system background.

**The ticket sheet at either width.** The main Router opens every ticket and New session in a
ticket sheet (`TicketSheet`: an id, a root and its own path) and keeps every sheet it has opened
in `dockedSheets`, most recently used first; the first is the one on screen (`ticketSheet` while
presented, `dock` while docked). Only the presentation follows the width. `TicketSheetContent`
(App/TicketSheetHost.swift) is the body both use: one sheet's ticket or New session in its own
NavigationStack bound to that sheet's path by id (`setTicketSheetPath(_:id:)` only takes the
presented top's). A link inside it (a child, dep or parent, a file, a ticket link in markdown) is
`router.push` and stacks there with Back. A ticket chosen outside it is `router.openTicket` (board
cards and their Open parent, the Inbox's triage Open when not itself inside the sheet, which reads
`\.inTicketSheet`) or `router.openFromOutside` (notifications, URLs from other apps, section links
from ticket windows), and so is a ticket link while docked or gone: the sheet already showing it on
top comes forward as it is (switched to a tab the link names), else one with it at the root comes
forward popped back to it, else a new sheet joins the dock on top. Nothing is ever dropped to make
room. New session works the same way (the same New session comes forward); a ticket pushed onto a
presented New session takes its place, and `replace(newSession, with:)` turns New session into its
ticket in place wherever it sits in the list.

`activateSheet(id:)` makes any sheet the top, presented or docked as the top was.
`waitingSheets` is what the dock draws as cards: every sheet while docked, the ones behind the
presented top while a ticket is up (the presented ticket is the sheet, not a card). `dismissSheet()` and `closeSheet(id:)` close one sheet:
when it was the top, the next becomes the top, docked. `dismissAllSheets()` is Projects.
`removeTicket` and `replaceTicket` reach into every sheet and touch only the matching ones. Only the
first `liveSheetCount` (5) are live (`liveSheets`): both hosts mount a `TicketSheetContent` for each
in a ZStack, the top visible and the rest at opacity 0, without hit testing, accessibility or key
commands (`disabled`), so switching is instant and keeps scroll, path and drafts. The rest are
parked: the Router's small root and path, drawn only as a minimized card from the board's own
`Ticket` (`DockedTicketText`, `BoardState.ticketByKey`), never a `TicketDetail` or a mounted view.
Opening a parked one mounts it fresh at its saved path, and the live sheet used least recently
parks.

Docked tickets show as custom minimized cards rather than system menus (App/DockedTickets.swift).
A `DockedCard` is its own fully rounded glass capsule, 52pt tall like the single docked sheet
(`DockedCardMetrics`, 8pt between cards), with a status dot (`StatusDot`, the board's colors: green
done, red blocked; a pencil for New session), the ref whole and the title truncated into the rest
(`DockedTicketLabel`), and an ✕ that closes just that ticket; a tap anywhere else opens it. It's one accessibility element,
"<ref>, <title>, docked" (`ticket-dock`), with a Close action, and its ✕ is "Close <key>"
(`ticket-dock-close`). `DockCards.split` (HarnessKit) decides how many cards show: up to
`phoneVisible` + 1 (3 rows) or `padVisible` + 1 (6 rows) show as they are; past that, `phoneVisible` (2) or `padVisible` (5), the most recent at the bottom, then a `DockedMoreCard`
("N more…" and a stack icon, `ticket-dock-more`, "<n> more docked tickets") on top counting the
rest, in the same glass capsule. It expands into `DockedCardList`: the docked tickets as the same
glass cards, the most recent at the bottom, scrolled to the bottom and scrolling up past the height
it's given, under a small glass capsule that collapses it. The list has no background of its own;
it sits on a `DockedBackdrop`, a radial progressive blur (a material masked by a radial gradient,
plus a light tint of the palette's background) rising out of the bottom on iPhone and the
bottom-right corner on iPad. Both platforms draw the cards with one container, `DockedCardsContainer`
(App/DockedTickets.swift): it owns the cards, the "N more…" expansion and its backdrop, `open` (the
ticket becomes the top, and the sheet is presented if it was docked) and ✕ (a file holding unsaved
edits comes forward instead of closing, on both). What differs is a `DockedCardsLayout`: the
iPhone's is full width with the bottom bar's side inset and `phoneVisible` cards, rising from the
bottom; the iPad's is the corner, a fixed card width from `DockMetrics.cardMode`, `padVisible` cards
fitted to the height, and the three modes. On the iPad the title's long press (`TicketDetailHero`'s
`.dockedTicketsMenu`, in the panel only) also lists the other docked tickets as a system context menu
(`DockedTicketsMenuItems`: the first `Router.shownDockCount`, 10, then "N more"); the iPhone has no
such menu, since its cards are over the ticket.
`DockedTicketsKeeper` (on MainTabs) holds `BoardStore.watchKey` for every docked key, so a done
ticket the board hasn't paged in still has its title, and drops the sheets of keys the server
reports missing (`missingKeys`) through `removeTicket`.

The sheets survive a relaunch on the device only: RootView saves `persistedState` (every sheet's
root, path and per-ticket tabs, their order, whether the top is docked, the phone's board column
(`Router.boardColumn`) and the save time; `Route` and `TicketSheet.Root` are `Codable`) to
UserDefaults under `harness.restore.<server id>` when the scene goes to the background, and
restores it once there's a store, open sheets open and docked ones docked. State older than 24
hours isn't restored. A link or notification that opened a sheet at launch keeps the top; the
saved sheets join the dock behind it. The old global `harness.dockedTickets` is read once as a
fallback. UserDefaults rather than `@SceneStorage`, which state restoration drops when the app is
swiped away. A restored entry whose root doesn't decode is dropped, and a path keeps its routes up
to the first that doesn't, so a build that adds a route never fails a launch. A restored ticket
that has gone shows the ticket screen's "not found" (or `DockedTicketsKeeper` closes it once the
server reports it missing). Only the top mounts at launch; the rest stay parked until opened.

A layout flip (the Plus/Max rotating across the size class) swaps the system sheet for the side
panel and back, so the content mounts again: the selected tab lives on the sheet
(`TicketSheet.tabs`, written by the ticket screen), not only in view state. The system reports the
withdrawn sheet as a dismissal; `sheetDismissedBySystem` ignores it while the panel shows and for
`layoutFlipGrace` after a flip.

At compact width SceneChrome presents the ticket as one plain `.large` system sheet
(`TicketSheetHost`) while the Router is `.presented`; the sheet is a view of the Router's state, and
adding or switching tickets swaps its content in place without presenting it again. The system owns
the drag, its momentum and the dismissal, and the app never inspects them: when it takes the sheet
down (a swipe away, the two-finger escape, UIKit dismissing it) the root's binding calls
`Router.sheetDismissedBySystem(dock: false)` and the ticket closes, however fast or far the swipe
went. With tickets left, the next stays as the docked card and no sheet comes up. TicketSheetHost
presents pickers, the watcher form and covers over itself.

Docking is a separate, deliberate gesture: drag the sheet down and hold the finger in the bottom 40%
of the screen for about 0.5 s while the sheet is more than 80pt from rest. `DockArming`
(HarnessKit) is the one rule for it, axis-agnostic (the finger's progress along the way out as a
fraction of the screen, and the displacement) so the phone and the iPad panel can't drift apart; it
reads no velocity. On the phone `DockHoldRecognizer` is a passive `UIGestureRecognizer` on the
sheet's container view that never leaves `.possible` (a long-press would time from touch-down,
hit-testing is cancelled once the system pan takes over, a SwiftUI drag blocks scrolling) and reads
touches in window coordinates; the sheet's displacement is its presentation layer's frame against
where it rested, which is also how a thumb resting low during a scroll is told from a drag, since the
sheet hasn't moved. `DockHold` runs it (a task wakes when a still finger's hold would arm) and fires a
medium haptic when it arms. Armed, a ghost dock card (`DockGhostCard`, "Dock") shows at the bottom as
the dock window's incoming slot (above the sheet, which covers the main window below its top edge);
nothing sets a transform on the presented view, since UIKit drives its frame. A release
while armed latches a timestamped intent that the dismissal binding reads and clears once
(`takeIntent`), so a programmatic dismissal can't dock; if the system cancels an armed dismissal, an
upward flick say, `notifyWhenInteractionChanges` docks it anyway. VoiceOver has a "Dock" custom action
on the sheet and no visible button. This leans on sheet internals (the presentation layer, the
container view, the transition coordinator): there is no fallback if a release breaks it, and
`git revert` is the way back.

The iPhone's dock is one persistent dock in a window of its own (`DockWindow`, App/DockWindow.swift),
above the main window and everything it presents, which is why the cards show over the board, the
open ticket sheet and a file sheet alike: anything hosted inside the system sheet would remount with
each presentation. RootView creates one `DockWindow` per main window scene at compact width (none for
a ticket window, and torn down at regular width, where the iPad's panel host draws its own stack),
and it hosts `DockedCardsContainer` with the router, the app model, `DockHold` and
`DockedSheetInset` in its environment. It never becomes the key window (`canBecomeKey` is false, so
the composer keeps first responder), forwards the status bar style and orientations to the main
window's root, and takes touches only where the cards are: `DockWindow.hitTest` reads the rects the
container publishes (`DockedCardsReport`), or the whole screen while the list is open, rather than
asking whether the hit view is the root, which SwiftUI's gesture views make unreliable on iOS 18+.
The container never mounts again while the app runs: cards insert and remove by id, so opening a sheet from the board, switching
tickets from a card, or docking changes only the cards that change. Each card is `DockedCard`, 52pt
tall, 8pt from the home indicator and in from the sides as far as the board's bottom bar (its
concentric inset, `DockMetrics.phoneSides(screen:)`), the most recent at the bottom, up to three; with more, two and
"N more…" on top. The dock is shown while there are waiting cards or the hold-to-dock ghost, and
fades out (`DockCards.isShown`) while a keyboard is up, a picker, the palette or a cover is
(`Router.sheet`, `.cover`), or a dialog the Router doesn't know about is: an alert, action sheet,
share sheet or photo or document picker presented from the main window's controllers, which a short
poll in the dock window looks for. The container publishes where the top of the collapsed stack is
(`DockedSheetInset.stackTop`): `DockClearance` gives the board's bottom clearance down to that
measured top (`DockMetrics.clearance`, with or without a keyboard). The board's system bottom bar
can't be moved, so the board reports its height (`DockedSheetInset.barInset`) and the dock floats
its cards above it (`DockMetrics.lift`); the board keeps its own room above the bar
(`DockMetrics.boardClearance`, `DockClearance(board:)` skips it) and the ticket sheet leaves the bar and cards where they are. In the ticket sheet each screen keeps the same room at its bottom
(`SheetDockRoom`, inside the stack's screens like the board's), and the composer sits
`TicketDock.barGap` above it (`TicketDock.composerGap`); a keyboard drops both
(`DockedSheetInset.keyboardUp`), as the dock is hidden then and the composer rides the keys. "N more…"
expands every waiting ticket into the `DockedCardList` over the screen on the backdrop; a tap on the
backdrop collapses it. A tap on a card makes its ticket the sheet (`activateSheet`, plus `restoreDock`
when docked), a card's ✕ closes it. There is no gesture on the cards and no VoiceOver Next or
Previous: the cards are how a person switches. VoiceOver has Close on each card, and focus moves to
the bottom card after a ticket docks. Reduce Motion fades the cards and the ghost. The ghost dock card
is the dock's incoming bottom slot: the cards lift one row (an offset, with no clearance asked for),
and a release docks the ticket into it. Screen tests draw only their own window, so Renderer
composites the dock window over the screen, drawing it over a picture of what is below it so the glass
has something behind it.

The ticket's view is torn down on dismissal, which docking now does too. Composer drafts are the
board store's (`BoardStore.messageDraft(for:)`) and the stack's path is the Router's. What the view
itself held is kept by ticket in `TicketViewMemory`: each tab's scroll offset (`ticketHeroScroll`,
except the feeds that stick to the bottom, which follow the latest) and whether the composer had the
keyboard, where a blur within half a second of the composer leaving the screen counts as the
dismissal's. A ticket that closes for good forgets it.
At regular width SceneChrome
presents no ticket sheet at all (a system sheet there is a centered form sheet): DesktopShell
overlays `TicketPanelHost` (App/TicketSidePanel.swift), and the root presents `sheet` and the
cover as usual. The host puts the content in `TicketSidePanel`, which slides in from the
trailing edge over the split view with no dimming, so the board and sidebar to its left stay
live. It's resizable from its leading edge between 25% and 80% of the window
(`TicketPanelWidth`: 800pt until the person drags it, then their fraction of the window, kept
as the `ticketPanelWidth` pref and re-clamped on rotation). It has no bar of its own: the
dock, pop-out and close buttons float over its top trailing corner, and the root ticket's hero
title starts at the top, wrapping before them (`\.ticketPanelTitleInset`). The root ticket's
screen hides its navigation bar (`TicketDetailHeader`), as does every ticket; a pushed ticket's
hero draws Back (`ticket-back`) beside its title, only when `isPresented` says there's a screen
under it. New session in the panel likewise drops its own title and Cancel ✕, keeping Plan first
and Start session. While it's on top it hands its `cancel()` to the panel through
`TicketPanelCloser` (in the environment, from TicketPanelHost), so the panel's ✕ and Esc ask Save
or Discard for a typed draft as Cancel does and close an empty one at once; with nothing
registered they just dismiss. Docking, pop-out and a card's ✕ don't ask, and the draft is
saved as whenever the screen goes. A rightward drag on the panel's top edge or its button corner moves the panel with the finger (iPadOS has no native side sheet, so the panel decides itself, as little as it can). `PanelRelease` closes the ticket when the drag moved at least 40pt and its projected end (`predictedEndTranslation`) passes half the panel's width, else it springs back; either way the slide is a spring seeded with the finger's release velocity, so momentum carries through. Speed and distance never dock: holding the finger in the trailing 40% of the window for about 0.5 s with the panel dragged more than 80pt clear arms the same `DockArming` rule through `DockHold`, the host (`TicketPanelHost`) draws a ghost dock card in the bottom slot of the docked card stack (the cards shift up a row, nothing reserves room; collapsed, it covers the one card), and releasing then slides the panel to the card and docks it. The panel has a VoiceOver "Dock" action and keeps its dock button. Esc closes it too.
Docked, the panel stays mounted (drafts, scroll and path survive) but off the edge and `disabled`,
and every docked ticket waits as a glass-capsule `DockedCard` in the same `DockedCardsContainer`, the same
cards as the iPhone's, in the board's
bottom-right corner inside the safe area, stacking upward with the newest at the bottom. While the
panel is open the other docked tickets' cards stay there, their trailing edge on the panel's
leading edge (`TicketSidePanel(onWidth:)` reports it as it resizes). The stack keeps to the board's
column and never covers the sidebar: DesktopShell measures where the column starts
(`DockedSheetInset.contentLeading`), and `DockMetrics.cardMode` (through `DockedCardsLayout.pad`) picks cards when the column left of
the panel has room for one at least 200pt wide, the "N more…" card alone ("<n> docked tickets")
holding every docked ticket when it has less, and nothing when even that won't fit (a wide panel;
the title's long press still lists them). Each card is about 320pt wide (`DockMetrics.maxCardWidth`,
narrower in a narrow column); a tap opens that ticket in the panel and its ✕ closes just that one.
At most five show, fewer when the height doesn't fit them (`DockCards.split`'s `fitting`), then
"N more…", which expands the `DockedCardList` over the corner, as tall as its cards up to the
window's height, on a `DockedBackdrop` out of the column's bottom-right corner (a tap on it
collapses the list). The stack's height goes to `DockedSheetInset.cards`, which `DockClearance` adds at
the bottom of the desktop's sections so their last cards scroll clear of it. Each sheet has its own `TicketPanelCloser`
(`TicketPanelClosers`), so a hidden New session never takes over the ✕ of the ticket on top. The
composer measures its bottom gap from the screen's edge in the iPhone sheet (`\.concentricBottomGap`
0), whose screens ignore the bottom container safe area (`TicketSheetContent(toBottomEdge:)`): the
sheet runs to the screen's bottom edge, so the composer measures its own gap. The panel leaves both unset, so the composer sits on the home indicator's inset or the keyboard.
MainTabs sets the Router's `sheetIsBesideBoard` from the size class, so presence counts the board
while the panel is up. A size-class change hands the same sheet across (same id, path, state and
draft): the system sheet goes away without a dismissal and the panel picks it up, or the other way
round.

The board inside it has two layouts, also picked by `horizontalSizeClass`, so an iPad in a narrow
Split View or a small Stage Manager window gets the phone's:

- **Pager** (compact): `BoardStatusStrip` over a paging horizontal `ScrollView`, one
  `BoardColumnView` per page, the landing column and the swipe haptic. A width change (the sidebar
  hidden or shown, a rotation) snaps it back to the column on screen (`onGeometryChange`).
- **Columns** (regular, iPad): every column at once, as on the Mac. Each is a `BoardColumnFrame`
  (rounded `bgColumn` panel, header with dot, label and count) around the same `BoardColumnView`,
  so cards, paging footers, empty states and pull to refresh are shared. There is no strip: the
  headers read "Planning, 3" like the chips (dev-sim's `screenState` and
  AXe taps rely on it), and a tap on one scrolls its column into view. Widths come from
  `BoardScreenRules.columnSizing` (equal shares of the detail column's width, so they follow the
  sidebar toggle; 216…400pt, the Mac's 216 minimum):
  five fit an 11-inch iPad in landscape, and anything narrower keeps the minimum and scrolls
  sideways without paging. The board starts at Planning (no landing column). Which columns are
  on screen comes from `onScrollVisibilityChange` (all of them when they fit) and drives Done's
  autofill (`shouldAutofillDone`).

Neither layout moves cards between columns: only agents move tickets, so a card has no drop
target, no Move to … in its menu and no VoiceOver move actions. Touch and hold lifts the ticket's
screen, on the Spec tab in a navigation stack of its own, as the context menu's preview (a
draft's lifts the card itself); a tap opens the ticket.

## Windows

The iPad runs several windows (`UIApplicationSupportsMultipleScenes` in project.yml; iPhone keeps
one). HarnessApp has two WindowGroups: the main window (`MainWindow` → RootView) and the ticket
window (`TicketWindowRoot`, App/Windows.swift), keyed by `TicketWindowValue` (HarnessKit/Shell).
`AppModel`, its `BoardStore` and `Actions` are app-wide and shared by every
window. Each window has its own `Router`, so its stack and sheets never move another window's, and
`sceneChrome(router)` (RootView.swift) gives each one its sheets, harness:// handling, palette,
tint and bar colors. HarnessApp forwards the app's scene phase (active while any window
is) to the store, never a single window's.

- **Opening a ticket window.** A card tap or ticket link opens the ticket side panel (see iPad
  layout), never a window. A ticket window opens on request: the panel's pop-out button
  (`router.popOutSheet()`, which hands the sheet's top ticket to `onOpenTicket` and dismisses the
  sheet), and "Open in New Window" in the card's menu or a tab's menu (the ticket's own screen has no opener).
  `WindowDirectory.mainActive` sets each main Router's `onOpenTicket` only when
  `UIApplication.shared.supportsMultipleScenes`, so `canPopOutSheet` is false on iPhone; the
  panel also hides pop-out without `supportsMultipleWindows`.
  `WindowDirectory.openTicket` requests a scene with `UISceneSessionActivationRequest`, an
  NSUserActivity carrying the ticket (`TicketWindowValue.activityType`, listed in
  NSUserActivityTypes; `targetContentIdentifier` = `sceneMatch`, which the ticket WindowGroup's
  `handlesExternalEvents` matches) and `UIWindowSceneProminentPlacement`: the system's centered
  window over the board, which the user moves, resizes, tiles or puts in Slide Over with the
  window's own controls. Nothing in the app draws a panel or handles a drag for it. Each ticket
  gets a window of its own; a ticket that already has one (WindowDirectory tracks them by key)
  brings it forward instead (`router.show(route)` and an activation request for its session).
  A closed window's Router and scene can outlive it, but an activation request for its destroyed
  session does nothing, so WindowDirectory only reuses an entry whose scene is still attached and
  whose session is in `UIApplication.openSessions` (`Entry.isOpen`); otherwise it opens a new
  window. Pop-out and every "Open in New Window" go through `WindowDirectory.openTicket`, so
  they bring an open window forward rather than opening a second.
- **Pinned windows (tear-off).** `TicketWindowValue` has `pinned` and `browserTab`, and its `tab`
  can be `TicketWindowValue.composer`. A pinned window is one torn-off thing: a ticket tab, one
  browser tab (`browserTab`; the whole Browser tab when nil, chip strip and all), or the composer.
  TicketWindowContent renders it as `TicketDetailScreen(pinned:)`: the hero collapsed to its title
  line (the approval card still shows), then only that tab's body (`TicketTabBody`, the same view
  the pager uses, so everything works as in the ticket), or only the composer. No tab strip,
  pager or composer otherwise; a pinned browser tab has no chip strip or New tab button, and
  shows "This tab was closed" when its tab goes. Its toolbar has a Return to ticket button.
  Windows are unique by `TicketWindowValue.identity`: (key) for a full window, (key, tab,
  browserTab) for a pinned one. `openTicket` looks a pinned window up among
  `UIApplication.openSessions` by the value each saves in its session's `userInfo`. A drag spawns
  its scene without asking the app, so a new ticket window whose value is already open (another
  session with the same identity) activates that one and destroys itself.
- **What's torn off.** `WindowDirectory` is `@Observable` and publishes `pinned`, every open
  pinned window's value, re-read from `openSessions` when a ticket window saves its value
  (`remember`) and when a scene connects or disconnects. A disconnected scene doesn't count (UIKit
  can keep listing its session a moment longer, and the system may let a background one go; it
  counts again when it reconnects), and sessions that were never connected after a relaunch do
  count. `tornOff(key)` gives a ticket's `TornOffTabs` (HarnessKit: whole tabs, browser tab ids,
  the composer). TicketDetailBody (a full ticket window or the pushed screen) shows a
  `TornOffPlaceholder` for a torn-off tab's page, `ComposerReturnBar` in the composer's slot, and
  BrowserTabView the placeholder over the stage when the selected chip's tab is torn off; torn-off
  chips carry a window mark. **Return to this window** calls `WindowDirectory.close(value)`
  (`requestSceneSessionDestruction`, and the session stops counting at once) and selects the tab
  here.
- **Drag out.** `TicketWindowDrag.provider(value)` builds an `NSItemProvider` registering the
  window's NSUserActivity (`WindowDirectory.activity`), so a drop outside the window has iPadOS
  open that window. `.tearOff(value, tornOff:onReturn:)` (Features/Ticket/TearOff.swift) adds the
  drag and the Open in New Window / Return to this window context menu to the tab chips
  (TicketDetailTabStrip), the browser chips (`BrowserTabChip`) and the composer's grip
  (`ComposerGrip`); `BoardTicketCard` adds only the drag (`.tearOffDrag`, drafts excluded), since
  its menu already has Open in New Window. All of it is gated on `\.canTearOff`, which
  `sceneChrome` sets to `supportsMultipleWindows && horizontalSizeClass == .regular`: nothing drags,
  the menu items are hidden and there's no grip on iPhone or at compact width. The board has no
  drop destination, so a card's drag never moves it between columns.
- **A ticket window's Router** has the `.ticket` scope: `root` is its ticket, pushes (sub-tickets,
  files, triage) land on its own stack, sheets are its own, and a section link (`.tab`, such as
  harness://board) goes to `onSectionLink`, which WindowDirectory sends to the last active main
  window and brings forward (opening one if none is open). A deleted ticket or a draft sets
  `closeRequested`, and the window destroys its scene. These semantics are tested in
  RouterWindowTests.
- **Restoring.** SwiftUI saves the WindowGroup's value with the scene only when `openWindow` gave
  it (and `@SceneStorage` didn't come back for activation-made scenes either), so TicketWindowRoot
  also keeps the ticket in the scene session's `userInfo`
  (`TicketWindowValue.userInfo`), which UIKit saves across launches. A relaunch brings ticket windows back on their tickets; their stacks start
  over at the root.
- **External links** (`onOpenURL`) prefer a main window (`handlesExternalEvents(preferring:)` on
  RootView; a ticket window only allows them), so harness:// from outside the app never lands in a
  ticket window or opens a new one.

The simulator's backboardd sometimes aborts in Metal texture validation (`MTLSimDriver`,
`CA::OGL::FlattenNode`) during long iPad runs with ticket windows open, and the app and
AXe's tree go with it. That's the simulator's renderer, not the app. Reboot the device
(`xcrun simctl shutdown`/`boot` under its lock) and rerun.

## Notifications (push and presence)

The service decides which card activity notifies and sends it through APNs (DESIGN.md
"Notifications"). The app does no filtering of its own:

- **Registration.** `App/Notifications.swift`: an `AppDelegate`, attached with
  `UIApplicationDelegateAdaptor`, receives the APNs token. `PushCenter` asks for permission at
  launch and syncs registrations. `HarnessKit/Shell/PushRegistrar.swift` posts the token to
  `POST /devices` on every saved Mac, not only the active one, so each Mac's service can push. It
  retries Macs it couldn't reach and removes the device from a Mac when you forget it
  (`AppModel.willForget`, while that Mac's token is still stored). The device id is a UUID kept in
  the Keychain. `Logic/Push.swift` tells sandbox from production by the embedded provisioning
  profile: TestFlight builds have none.
- **Display and taps.** The `UNUserNotificationCenterDelegate` shows foreground notifications as
  they arrived. A tap reads `ticketKey` (falling back to `aps.thread-id`) and opens
  `harness://ticket/KEY`. On a cold launch, `WindowDirectory.openFromNotification` holds the link
  until the first main window is up.
- **Presence.** `.reportsPresence(router)` on main and ticket windows feeds `PresenceTracker`
  (`Shell/Presence.swift`), and `PresenceRules` turns scene phases, routes and ticket windows into
  `{ visible, tickets }`.
  - The board lists `BoardColumns.shownKeys`, the same cards `BoardScreen` shows.
  - A presented ticket sheet counts as just its ticket, and a docked one adds the board.
  - On leaving, the app sends `visible: false` in the inactive phase, inside a short background
    task, so it reaches the Mac before suspension.
- **Tests and dev-sim.** The launch prompt would cover the pair link's screens, so `install()` writes the
  `HarnessSkipNotificationPrompt` default. The `-HarnessSkipNotificationPrompt YES` launch argument
  does the same.

## Widgets

The Active tickets widget (small, medium and large, each with a Compact setting) comes from one set
of sources, `ios/Widgets/Sources`, built twice: as `HarnessWidgets` (iOS, embedded in the app's
PlugIns) and as `HarnessMacWidgets` (macOS 15, which `app/scripts/package.ts` builds and embeds in
the Electron app's `Contents/PlugIns`). Everything that doesn't draw is in HarnessKit `Widgets/`:

- `WidgetFeed` picks the active tickets: not done, not a draft, and in progress, blocked, in review
  or busy (a planning ticket counts only while a run drafts its plan), most recently updated first.
  It resolves each one into a `WidgetTicket` (display key, project key and color, approval tool,
  blocked reason, latest news line), so the widget needs no board state. `WidgetFeed.fetch` reads
  the same thing from the service (`GET /tickets?status=…`, `/projects`, and Activity for the first
  three).
- `WidgetShared` is the App Group container: `widget-host.json` (`WidgetHost`: base URL, token,
  server name, theme ids) and `widget-snapshot.json` (the last `WidgetSnapshot`). The group is
  `group.com.markhuot.harness` on iOS and the team-prefixed `47P4ZSALX4.com.markhuot.harness` on
  the Mac, which a Developer ID app can use without a provisioning profile.
- `WidgetLoad.load` is the timeline provider's whole job: with a host, fetch live and save the
  snapshot; when the fetch fails, show the saved snapshot with its age; without a host, "Not paired".
  The timeline asks again every 15 minutes.
- `WidgetSyncState` decides what the iPhone/iPad app writes. `Harness/App/WidgetSync.swift` watches
  the active server, prefs and board (at most one sync a second) and reloads the timelines only
  when the snapshot's content or the host changes. A board that hasn't loaded keeps the saved
  snapshot, and forgetting the server clears both files.

On the Mac the Electron main process writes the host when it connects or the theme changes
(`app/src/main/widgets.ts`; packaged builds only), and the renderer sends a signature of the
board's open tickets so main can run `Contents/MacOS/harness-widgets-reload`
(`Widgets/macOS/reload-widgets.swift`, at most every 5 seconds). The widget extension is sandboxed
(`HarnessMacWidgets.entitlements`: network client and the App Group), and `sign-mac.ts` signs it
with those entitlements. Taps open `harness://ticket/<key>`, which the iPhone app routes with
`DeepLink` and the Mac app maps to `#/board/all/ticket/<key>` (`routeForLink`).

The entitlements are `properties` in project.yml: XcodeGen overwrites an entitlements file with an
empty dict when a target names only its path (config.test.ts checks this). The ad-hoc simulator
build carries the App Group as simulated entitlements, so the widget works there too. Add it from
the home screen's Edit → Add Widget; the size picker is in a widget's long-press menu. The
Compact switch in Edit Widget doesn't take AXe taps.

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
| ExtensionSettingsScreen | Settings/ExtensionSettingsScreen.swift | Settings | `ExtensionSettingsScreen()` (HARNESS-285, the Mac's Settings → Extensions) |
| PromptsScreen | Prompts/PromptsScreen.swift | Prompts | `PromptsScreen()` |
| PromptDetailScreen | Prompts/PromptDetailScreen.swift | Prompts | `PromptDetailScreen(id: String)` |
| WatcherFormScreen | Watchers/WatcherFormScreen.swift | Watchers | `WatcherFormScreen(id: String?)` |
| NewSessionScreen | NewSession/NewSessionScreen.swift | New session | `NewSessionScreen(projectId: String?, key: String?)` |
| FileViewerScreen | Files/FileViewerScreen.swift | File viewer | `FileViewerScreen(params: FileRouteParams)` |
| MarkdownView | Content/MarkdownView.swift | Markdown | `MarkdownView(text:, size: = 15, color: = nil, linkContext: = FileLinkContext())` |
| CodeBlockView | Content/CodeBlockView.swift | Markdown / File viewer | `CodeBlockView(code:, language: = nil, showLineNumbers: = false, highlightLines: ClosedRange<Int>? = nil)` |
| DriverModelPicker | Pickers/DriverModelPicker.swift | Pickers | `DriverModelPicker(value:, resolved:, title:, defaultLabel:, onlyDriver:, disabled:, inheritedModel:, onChange:)` (Watchers.TriageChoice) |
| PhaseModelPicker | Pickers/PhaseModelPicker.swift | Ticket, project and app settings | `PhaseModelPicker(value: PhaseModels?, inherited: PerPhase<PhaseChoice>?, title:, disabled:, onChange: (PhaseModelsPatch) -> Void)` (Models.phaseMatrix) |
| ModelPicker | Pickers/ModelPicker.swift | Pickers | `ModelPicker(driver:, value:, inherited:, defaultLabel:, plainDefault:, title:, disabled:, onChange: (String?) -> Void)` |
| PermissionPicker | Pickers/PermissionPicker.swift | Pickers | `PermissionPicker(value: PermissionMode?, inherited:, disabled:, onChange:)` |
| BranchPicker | Pickers/BranchPicker.swift | Pickers | `BranchPicker(projectId:, value:, defaultLabel:, newLabel:, title:, disabled:, onChange: (String?, BranchInfo?) -> Void)` |
| ProjectColorPicker | Pickers/ProjectColorPicker.swift | Projects | `ProjectColorPicker(value: String?, onChange:)` |
| MentionTextEditor | Pickers/MentionTextEditor.swift | Transcript / New session | `MentionTextEditor(text: Binding<String>, placeholder:, projectId:, ticketKey:, minLines:, commandDriver:, commands:, maxLines:, suggestionsEdge:, suggestionsMaxHeight:, boxed:, search:, searchCommands:, fieldLabel:, placeholderColor:, onFocusChange:, fieldBox:)` (all after `text` optional) |
| TicketSettingsForm | Pickers/TicketSettingsForm.swift | Ticket detail | `TicketSettingsForm(ticket: Ticket, branches: TicketBranches? = nil, onPatch: (UpdateTicketBody) -> Void)` |

Done in the shell (not slots): ConnectScreen, PairScreen and ScanScreen (Features/Connect). The
board's decisions that don't draw (landing column, card menu and AX label, column sizing, when
Done tops itself up) are in HarnessKit's `BoardScreenRules`. The shared parameters a
slot needs come from the environment (store, router, palette), not from extra initializer arguments.

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

- **`.ticketHeroScroll()`** on a tab body's ScrollView or List: a forward drag or fling collapses
  the hero to its title line (HarnessKit `HeroCollapse`, then
  `HeroDisclosure`); nothing a scroll does expands it again, only its chevron.
  TranscriptView and AgentsTabView should attach it. Outside a ticket screen it does nothing.
- **`.ticketStickToBottom()`** on a ScrollView whose newest content is last (Activity, and the
  Transcript): it opens at the bottom, follows new content while pinned, stays put once the user
  scrolls up and re-pins at the bottom (StickToBottom.stickStep, fed by scroll phases).
- **`@Environment(\.ticketDetailOpenTab)`** opens a tab on the hosting screen, which is how the
  Agents list and the Transcript's sub-agent rows open `Tabs.subagentTabRoute(id)`, and how a
  sub-agent's Back returns to `.agents`. A tab change also brings the hero back.
- The composer sits in the screen's bottom `safeAreaInset`, so tab bodies shouldn't add their own.
  Its field's AX label is always "Message the agent" (MentionTextEditor `fieldLabel`).
- Testable branches (menus, the Complete sheet's rules, run rows, labels) are in HarnessKit's
  `TicketDetailLogic`. Approve/Complete menus are native `Menu`s; AXe closes one with
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
  @pierre/diffs and shared/src/state/changes.ts, so a file changed again after viewing reads as
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
  root plays the error haptic. `ContentLinkOpener` is the same opener for links outside markdown.
- **CodeBlockView** takes a fence tag or a Shiki id; long-press → Copy copies the whole block.
- **MarkdownView** presents `AttachmentViewer` for `attachment:` images (a clear fullScreenCover that fades in).
  `AttachmentMedia` caches images and video posters for the inline images and the viewer. The pager is
  `AttachmentPager`, a UIKit paging UIScrollView whose pages
  are UIHostingControllers of the SwiftUI page views, given the store and palette explicitly. A
  page-style TabView lost sideways swipes that started over AVPlayerViewController's view, so the
  viewer often couldn't page off a video; inside the scroll view, its pan sees them first. Paging is
  off while an image is zoomed. A page keeps one view for its whole life, so video pages keep one
  AVPlayerViewController and only hand it a player while showing. Labels the tests read: "Image x.png" /
  "Video x.mp4" inline images (the alt text), "Close", "2 of 4 · 1.2 MB".
- **Debug gallery:** a paired Debug build launched with `-debugScreen content [-debugTicket KEY]`
  shows sample markdown and that ticket's spec with its inline attachments.

## Pickers and form controls (Features/Pickers)

What the hosting screens (Ticket detail, New session, Settings, Project settings, Watchers) get:

- **Selects.** `SelectMenu` is the app's select: a `Menu` of checkmark Toggles (subtitles,
  disabled rows, an actions section headed by the problem line) whose trigger, `SelectTrigger`,
  shows the value in the accent color with a spinner, a warning or the ⌃⌄ glyph. ModelPicker and
  PermissionPicker are built on it. DriverModelPicker, PhaseModelPicker and BranchPicker use the same trigger, but
  open a `PickerSheet`. PhaseModelPicker's sheet has a radio column per run phase and stays open
  after a pick. That sheet draws its own header (Cancel, the title and an accessory) instead
  of toolbar items, because AXe doesn't see a sheet's toolbar and AXe taps "Cancel" by label.
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
  watcher row lines, the identifier draft and Remove project copy.
- **Rows.** `SettingsRow(label:hint:)` puts the hint under the label and the control, so a long
  hint never squeezes a picker to "…" (TicketSettingsRow keeps the hint beside the label, which
  only suits short hints). `SettingsButtonRow` is a tappable row; `SettingsSectionHeader` is a
  header with a trailing icon button ("Add watcher", "Refresh drivers").
- **No modifiers on a Form `Section`.** SwiftUI applies them to every row of the section, so
  Settings' sections set `SettingsModel`'s `menu` / `confirm` / `textPrompt` and the screen
  presents them, and it runs the network, drivers and prompt-catalog loads once.
- **AXe and segmented Pickers.** AXe lists a segmented Picker as one unlabeled element, so a
  segment AXe taps or waits for ("Compare with built-in") is a labeled Button
  (PromptSegmented). Lazy Forms leave off-screen rows out of the AX tree too; the Prompts list is a
  plain stack so a row below the fold is in the AX tree.
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
- The prompt is a MentionTextEditor with `fieldLabel: "Prompt"` (AXe looks for it) and `autofocus`.

## File viewer (Features/Files)

- **Decisions live in HarnessKit:** `FileViewerRules` holds the title, subtitle, badges, meta line,
  Diff counts, body and diff states, error copy and Copy link. `FileViewerLoader` loads the file,
  then the diff when git says the file is dirty, dropping stale loads and splitting the lines and
  patch rows off the main actor. The editor's side is `FileEditor.swift` (`FileEditorCommand` and
  `FileEditorEvent`, the JSON codec for the web view bridge, and `FileEditRules`: what's editable,
  when a dirty file saves or asks, when a foreground reloads) and `FileEditorModel` (the unsaved
  state and the serialized writes: PUT `/tickets/:key/file` or `/projects/:id/file`, last write
  wins). `SettingsRules.saveOnBlur` reads the setting; an older service reads as off. All of these
  have tests.
- **The editor is `@pierre/diffs/edit` in a WKWebView** (`editor/` at the repo root; it replaced
  CodeMirror, HARNESS-484, so code is colored by the same Shiki pipeline as the Changes tab). The
  "Bundle editor" pre-build phase in `project.yml` runs `bun editor/scripts/build.ts --out …/editor.js`
  into the app's resources beside `Resources/editor.html`, which loads it and calls
  `HarnessEditor.mount(window, post)`. `post` stringifies each event to the `editor` message
  handler. `EditorWebHost` is the native end (modeled on `PluginWebHost`, with the same weak
  script-handler proxy): it loads the page from the bundle, drops commands until the page says
  `ready`, and calls `onReady` each time, so a `webViewWebContentProcessDidTerminate` reload
  reopens the editor on the unsaved text (`open` carries `saved`, what's on disk, so it comes back
  dirty). `EditorWebView` forwards Cmd+S from a hardware keyboard (`UIKeyCommand`); the page has
  autocorrect, capitalization and spell check off. The page scrolls (the editor's virtualizer reads
  the page's own scroll, `scroller: "page"`), so UIKit sees the web view's own scroll view: a sheet
  drags down from the top of the file, and the keyboard insets it natively. The theme goes in as
  `{appearance, tokens, syntaxTheme}` (`FileEditorTheme`: the tokens plugin tabs get color the
  chrome, `syntaxTheme` is the Shiki theme the code blocks use) and a theme change sends `theme`
  without reloading the page (the editor redraws). An IIFE can't split code, so the bundle lists
  its grammars (`BUNDLED_LANGUAGES` in `editor/src/language.ts`) and the app themes' Shiki themes,
  and `editor/scripts/build.ts` swaps every other Shiki grammar and theme, and the WASM regex
  engine (the JavaScript one is used), for an empty module: about 4 MB, against 10 MB with them
  all. A language outside the list shows as plain text. A file over 10,000 lines opens as plain
  text too.
- **`FileEditorSession`** owns the loader, the model and two hosts, the file editor and the
  side-by-side diff, so switching tabs never drops edits. Saving: Save in the file bar, Cmd+S, and Save on blur
  (the editor losing focus, the app backgrounding, the screen leaving). With the setting off, a
  dirty file's back button asks (Save / Discard / Keep editing) and swipe-back and sheet
  swipe-down are disabled; a pop that gets past it saves anyway, since edits are never dropped
  silently. A clean editor silently reloads when the app comes back to the foreground (`setContents`,
  no undo history); a dirty one keeps its edits.
- File/Diff is two labeled buttons, not a segmented Picker, because AXe taps the label that
  starts with "Diff". The counts use `Text(verbatim:)`, so 25000 doesn't render as "25,000".

## Terminals (Features/Terminal)

A terminal is a shell the service hosts, shared with the Mac (DESIGN.md "Terminals (service)"). The
phone shows it in a sheet, drawn by the same ghostty-web the Mac pane uses, in a web view.

- **The bundle.** `terminal/` (repo root) builds `terminal.js` (`terminal/scripts/build.ts`, an IIFE
  exposing `HarnessTerminal.mount`) in the "Bundle terminal" build phase (`project.yml`, inputs in
  `build/bundle-terminal.xcfilelist` from `Tools/build-cache.ts`), beside `Resources/terminal.html`.
  ghostty-web's WASM is inlined in the module, so the page needs no other file.
- **The bridge** (`HarnessKit/Logic/TerminalBridge.swift`, WebKit-free, tested): `TerminalCommand`
  (`open` with the theme tokens, `message` for each `terminal.*` message, `reconnecting`, `theme`,
  `focus`, `paste`, `ctrl`, `inset`, `frame`) goes to the page through `evaluateJavaScript`;
  `TerminalEvent` (`ready`, `input`, `viewport`, `title`, `exit`, `resync`, `ctrl`, `error`) comes
  back through the `terminal` message handler. `TerminalWebHost` (modeled on `EditorWebHost`) is the
  native end. The socket stays in Swift: `HarnessSocket` remembers each `terminal.attach` and sends
  it again after a reconnect, pings every 5 s while one is attached, and yields the `terminal.*`
  messages on `terminalMessages`; `BoardStore` keeps the terminal list (`terminals`, `GET /terminals`
  and events) and offers `attachTerminal` / `detachTerminal` / `resizeTerminal` / `writeTerminal`
  and `onTerminalMessage`.
- **Attaching** (`TerminalAttachRules`, pure): the sheet attaches once it is on screen, the app is
  active and the page has measured its viewport; it detaches when the app goes to the background or
  the sheet goes away (so a sleeping phone never holds the shell small), attaches again at the latest
  size on foregrounding or a rebuilt socket, and a `resync` from the page is detach then attach. The
  service sizes the shell to the smallest visible client, so the page draws at the size it gets,
  centered.
- **The keyboard** never changes the rows reported: the web view ignores the keyboard's safe area,
  the page is exactly the web view's size (`frame`; a shrink of at most 120 pt, the keyboard's
  accessory or the home indicator's inset, keeps the height it had: `TerminalViewportRules`), and the
  page pans to keep the cursor above the keyboard (`inset`). A tap focuses the terminal inside its own
  event, which is what brings the keyboard up. The accessory bar above the keyboard has Esc, Ctrl
  (armed for one key), Tab, the arrows and `|`.
- **The sheet** is `TicketSheet.Root.terminal(id:)`: it docks, persists in the dock's UserDefaults
  list and restores like a ticket or a file; one already open comes forward (`Router.openTerminal`).
  A card shows the title (else the program) and folder; a terminal the list no longer has shows
  "ended". The palette lists terminals (`PaletteRows` content `.terminal`) with a New Terminal command
  that creates one in the board's project (All projects when none) with `openOnMac`, so a connected
  Mac opens a pane for it at once.
- **Checks:** the terminal bridge, socket and router logic in `testing/swift`, and the Terminal
  screens in `testing/ios`.

## Screen tests

`testing/ios` renders the app's screens in a test bundle hosted by the app (`HarnessScreenTests` in
`project.yml`: the screens live in the app target, so a hostless bundle can't render them), from
the shared world in `testing/world`, through the real `HarnessClient` and `BoardStore` with only
the transport (`WorldTransport`) and the socket (`WorldSocket`) replaced. A request the world has
no route for fails the test. No daemon, install, pairing or accessibility polling.

```sh
bun run testing ios                          # check, iPhone, iPad then iPhone Duo (harness-shared, harness-shared-ipad, harness-shared-duo)
bun run testing ios --iphone --only=ScreenTests/testBoard
bun run testing ios --record                 # write/update the references after an intended change
bun run testing ios --out=/tmp/shots         # also write every render
```

- **Approach:** an in-house renderer, not swift-snapshot-testing. The repo has no third-party Swift
  dependency (the only package is local, and the JS side is bundled by bun); swift-snapshot-testing
  would be the first, plus the swift-syntax it pulls in, for what is a UIHostingController, a PNG
  and a pixel compare. `Renderer` puts the view in a real window in the host app's scene (real size
  classes, safe areas and traits), `ReferenceImages` compares.
- **Hosted:** the test bundle runs inside the app (`@testable import Harness`) under the
  `HarnessScreens` scheme, built `Debug` into `testing/.build`. Under XCTest `HarnessApp` stays an
  empty window: `MemoryStorage`, no widgets, no push registration.
- **Deterministic:** scale 2, animations off, the world's fixed clock (`\.snapshotNow` in
  `RelativeTimeText` and `NowReader`), light/dark by window style. A render waits for the display's
  frames to stop changing and the transport to have nothing in flight, never for a fixed delay.
  Spinners that repeat forever are frozen where they stand so a busy ticket can still settle.
- **References:** `testing/ios/references/<iphone|ipad|duo>/`, committed. They depend on the
  simulator's iOS runtime (27.0, or 27.1 for the iPhone Duo) and the device size.
- **A diff:** a failure writes `<name>.actual.png` and `<name>.diff.png` to a temp directory and
  prints the paths. A pixel differs when a channel is more than the tolerance off, and a budget of
  differing pixels is allowed. A missing reference fails and says how to record it.
- **Screenshots for a spec:** `bun run testing ios --out=<dir> [--only=…]` writes the renders.

## Disk budget (parallel agents)

Several tickets build at once on a Mac with little free disk. CLAUDE.md → Simulators has the rules;
for this app they come down to:

- Test only on iOS 27.0 (iPhone, iPad) and iOS 27.1 (the iPhone Duo). Never download a runtime or create a simulator.
- Use the shared `harness-shared` simulator through `bun run sim with-lock -- …`. dev-sim,
  `testing ios` and `testing walk` take the lock themselves.
- Build with `-derivedDataPath ios/build/dd` inside your own worktree and nowhere else.
- Run `bun run sim disk` before any `xcodebuild`, and block and ask when it exits 1.
- When you finish, delete `ios/build`, `ios/HarnessKit/.build` and `testing/.build`. Leave the simulator alone.

## Accessibility labels (read this before porting a screen)

The walkthrough and dev-sim find elements by AXLabel (through AXe): the visible text of an element,
or its `accessibilityLabel`. The rule for every screen:

- Keep the labels the apps' tests and tools look for exactly as they are: column chips
  "Planning, 3" (`"<Status>, <count>"`), card labels starting "GREET-1 <title>", "Options" /
  "Options, …", "Cancel", "Allow once", "Start work", "Message the agent…", "Reset to built-in",
  "Customize", "Image phone.png", "Prompt", "Model, …", "Agent review: skipped", "Remote ID JIRA-62"…
- A composite control whose label is read (a card, a chip) uses
  `.accessibilityElement(children: .ignore)` + `.accessibilityLabel(…)`, so AXe sees one element
  with the whole string instead of its pieces.
- The root AX element must stay the app ("Harness"), so no full-screen overlay may take
  accessibility focus above the window.
- Don't label a container whose children are tapped (`.accessibilityElement(children:
  .contain)` plus `.accessibilityLabel`): AXe then lists the container as one element and drops
  its rows. That's why the mention list and the project color swatches have no group label.
- Every route in § App shell is reachable by a `harness://` link (the same links the 1.x app
  took, so old links keep working), with the same semantics (a tab link pops to the tab root and dismisses modals; a ticket link pushes).

## Parity table

This is the historical parity audit against the 1.x React Native app, which has since been deleted;
the "RN file" column names files from that app. HARNESS-145 audited every file in its routes,
screens, UI kit, lib and state against `main` as of the HARNESS-155/157/160 merges: each
user-visible feature, action, state, empty state, error, haptic, deep link and persistence key,
read on both sides and checked in the simulator. Every row is done. "Differs" notes a deliberate,
native-pattern difference, not a missing feature.

| Feature | RN file | Swift file | Status |
| --- | --- | --- | --- |
| Keychain load before the first frame; one store per server + nonce | app/_layout, state/app, state/store | HarnessApp, Shell/AppModel, State/BoardStore | done |
| Storage keys `harness.servers`, `harness.prefs`, `harness.token.<id>` (after first unlock) | lib/storage, lib/servers, lib/prefs | App/KeychainStorage, Shell/AppModel, Logic/Prefs | done (one-way migration of the RN app's items) |
| Sections Board / Inbox / Settings, switched from the Projects sidebar (no tab bar) | app/(tabs)/_layout | App/RootView | done (differs: RN has a tab bar) |
| Theme: color scheme, accent tint, bg, nav title colors | state/app, app/_layout | App/RootView, App/BarAppearance, Theme/Palette | done |
| Actions + toasts (3 max, 6 s / 2.6 s) + haptics + pick/confirm | state/store useAction, ui/Toasts, ui/haptics, ui/pick | App/Actions, UI/Haptics, UI/Confirm | done (menus are native `Menu`s; no toasts, failures play the error haptic; differs) |
| UI kit: badges, buttons, cards, callouts, empty states, conductor rollups, parent crumb, related rows | ui/kit, ui/Conductor, ui/RelatedTickets | UI/* | done |
| Connect: Scan, saved Macs, manual entry, Keychain footer, "Token rejected", pairing sheet | screens/Connect, app/connect, app/pair | Features/Connect/ConnectScreen | done |
| Scan QR (permission, Open Settings, recheck on return, dedupe, haptics) | screens/Scan | Features/Connect/ScanScreen | done |
| Connection banner (re-pair on 401, reconnecting + load error) | screens/ConnectionBanner | UI/ConnectionBanner | done |
| Board: columns as pages, status chips "Status, n", landing column, swipe haptic | screens/Board, lib/boardColumns | Features/Board/BoardScreen, BoardColumnView, HarnessKit BoardScreenRules | done (iPad at regular width: all five columns side by side, as on the Mac) |
| Board (phone: no header); system bottom bar: Projects, command palette button, + New session (iPad: palette button and New session top trailing; ⌘F, ⌘K, and ⌘N with the window shortcuts) | screens/Board, ui/header | BoardScreen | done (differs) |
| Done paging, autofill, "Couldn't load older tickets. Retry", empty states, pull to refresh | screens/Board, lib/boardLoader | BoardColumnView, State/BoardLoader | done |
| Cards: badges, review marks, blocked/approval lines, rollups, dep chips, driver/model names, dimmed children, drafts | screens/TicketCard | BoardTicketCard, UI/Badges (ModelBadge) | done |
| Card menu (titled "KEY · title"): the ticket's own actions (Start work, Approve submenu, Request changes, Re-open, the More items), open parent, copy key, discard draft; VoiceOver actions | screens/TicketCard | BoardTicketCard, BoardScreenRules | done |
| Command palette: commands, tickets, ticket actions, Open file…, `>` `#` `@` prefixes, Show/Hide child tickets | views/CommandPalette | Features/Palette/PaletteScreen, HarnessKit Palette, PaletteRows | done (the board's column filtering is Mac-only) |
| Projects sheet (the sidebar, its header button badged with triaging or busy sessions): Inbox row (same badge), All projects, project group rows (HARNESS-269: `folder` icon and open count, alphabetical, under All projects), rows, settings gear, Add project, Settings at the bottom; on iPad a split view's sidebar column, hidden and shown by its toggle | screens/Projects | Features/Board/ProjectsSheet (ProjectsSidebar), ProjectsAdd, App/RootView DesktopShell, HarnessKit SidebarRow | done |
| Ticket screen: load, renamed key, not found, draft → New session, Remote ID list | screens/TicketDetail | Features/Ticket/TicketDetailScreen | done |
| Hero More (…): Move to done, Cancel run, Delete (no header menu, title at the top of the sheet) | screens/TicketDetail | TicketDetailScreen | done |
| Hero: crumb, status dot and title (compact on plugin/sub-agent, gone on Browser but for an approval card), a key row of ticket key, driver, model name, branch, PR, review marks and the context gauge at its end (no project, status or Conductor pill); 25pt above the expanded title, 14pt below the header | screens/TicketDetail | TicketDetailHero | done |
| Start work (Approve plan while a planning run goes, then a disabled Starts after planning: `Conductor.startState`), Approve (+ menu incl. clean up), Request changes, Complete (+ menu), agent review, Re-open, Cancel run | screens/TicketDetail, lib/approve, shared/completion | TicketDetailHero, TicketDetailSheets, HarnessKit Approve/Completion/TicketDetailLogic | done |
| Conductor-managed children: Approve/Complete disabled with the reason; on-base tickets offer no merge/PR | screens/TicketDetail (HARNESS-155/160) | TicketDetailHero, Completion.managingConductor/worksOnBase | done |
| Hero on every tab: in full on opening the Spec, collapsed to its title line with a chevron elsewhere; a Spec scroll or another tab collapses it, only the chevron expands it | ui/heroCollapse, lib/heroCollapse | TicketDetailSupport, TicketDetailHero, HarnessKit HeroCollapse/HeroDisclosure | done |
| Tab strip: order, counts, live dots, plugin icons, sub-agent highlights Agents | screens/TicketDetail, shared/state/tabs | TicketDetailTabStrip, HarnessKit Tabs/ChangesTab | done |
| Spec: the living spec, history bar (step, scrub, follow the newest, approved-plan tag), Show changes marking edits in the rendered spec, depends-on chips | (HARNESS-199, HARNESS-211) | TicketDetailSpecTab, MarkdownView (`previous`), HarnessKit SpecHistory/SpecScrubber/MarkdownDiff | done |
| Activity: typed timeline, blocked card, review round and commit, full text behind a one-line body (`meta.detail`), legacy message/answer bubbles, stick to bottom | (HARNESS-199, HARNESS-213) | TicketDetailActivityTab, HarnessKit ActivityRows | done |
| Tickets (children) tab: progress, waiting count, groups, rows with chips | screens/TicketTabs | TicketDetailChildrenTab | done |
| Details: title, spec (Unsaved/Revert/Save, base revision, Reload/Overwrite on a conflict), ticket settings, links, runs, related | screens/TicketTabs, ui/TicketSettings | TicketDetailDetailsTab, Pickers/TicketSettingsForm | done |
| Approval card: Allow once, Deny…, Always allow; announced to VoiceOver | screens/Approval | TicketDetailApprovalCard | done |
| Composer: placeholder by status, move switch while writing, @files, /commands, Send, then the Transcript tab once it went through | screens/TicketDetail, ui/mentions, lib/mentionCaret | TicketDetailComposer, Pickers/MentionTextEditor | done |
| Transcript: rows, deltas, Working…, thinking, tools (images, sub-agent links), permissions, errors, stick to bottom | screens/Transcript | TranscriptView, TranscriptRows, TranscriptToolRow, HarnessKit TranscriptLogic | done (windowed, "Show earlier messages (N)": native only) |
| Agents & tasks tab: sub-agents and background tasks (Bash, Monitor) in one list, latest update first, with type chips, under an Agents/Tasks filter with counts (kept per session while the app runs); sub-agent view (Back to Agents & tasks, breadcrumbs, task, transcript); task output view (command, output polled every second and following the bottom, notes, result); tool rows link with "Open transcript" / "Open output" | — (native only) | AgentsTabView, SubagentView, TaskOutputView, HarnessKit AgentsLogic/Subagents (`taskOutputs`) | done |
| Browser tab: toolbar, frames, touch/wheel/drag input, keyboard, resize gate, tab strip and New tab | screens/BrowserTab, lib/browserInput | BrowserTabView, BrowserTabModel, BrowserInputViews | done |
| Plugin tabs in a web view with the host bridge and theme | screens/PluginTab, lib/pluginHost | PluginTabView, PluginWebHost, PluginTabsLoader | done |
| Changes tab (the git plugin's page) | plugins/git/ui | ChangesTabView, ChangesRowViews, HarnessKit ChangesStore/ChangesRows/ChangesPatch | done (native; file paths open the file viewer: native only) |
| Inbox: watcher strip, Retry now, error expand, sessions, Inbox zero | screens/Inbox | Features/Inbox/InboxScreen, HarnessKit InboxLogic | done |
| Triage item: outcome, Open KEY, transcript, file-link scope | screens/Inbox, app/inbox/[id] | TriageScreen | done |
| New session: project, kind, prompt (@, /), Options, Start/Plan first, drafts, Cancel choices | screens/NewSession, lib/newSession, lib/draftSync | Features/NewSession/NewSessionScreen, HarnessKit NewSessionEditor/DraftSync | done (Cancel asks with an alert; differs) |
| Pickers: selects, model, permission, driver+model sheet, per-phase model sheet, branch sheet, project color | ui/selects, ui/DriverModelPicker, ui/BranchPicker, ui/ProjectColor, lib/modelSheet | Features/Pickers/* | done |
| File viewer: header, menu, File/Diff, ranges, editing and Save, errors | screens/FileViewer, lib/fileViewer | Features/Files/*, HarnessKit FileViewerRules/FileViewerLoader | done |
| Markdown, code blocks, file links + scope, attachments row and viewer | ui/Markdown, ui/CodeBlock, ui/fileLinks, ui/Attachments, lib/attachments | Features/Content/* | done (code copies by long-press; differs) |
| Syntax highlighting | lib/highlight | HarnessHighlight, Highlight/HighlightedText | done |
| Settings: Macs (Connect, Rename, Forget, Rotate token), network, appearance + themes | screens/Settings, lib/themePicker | Features/Settings/SettingsScreen, SettingsAppearance | done |
| Settings: drivers (each opens its screen) + per-phase models, general, permissions, triage | screens/Settings (HARNESS-157) | SettingsServiceSections | done |
| Driver screen: status, Log in, Anthropic API key | screens/DriverSettings, app/driver/[id] | Features/Settings/DriverSettingsScreen | done |
| Settings: prompts summary, watchers (menu, enable), projects | screens/Settings | SettingsListSections | done |
| Project settings: identifier rename preview, color, folder, agents, completion, Remove | screens/ProjectSettings | ProjectSettingsScreen | done |
| Project groups (HARNESS-269, after the RN app): group boards (`group:<name>` scope, Done paging and search by `group=`, regroup paging reset), the Group picker in project settings, New session defaulting into the group | — (desktop: shared/src/projectGroups.ts, state/groups.ts, state/paging.ts) | Logic/ProjectGroups, State/Paging, Shell/SidebarRow, Features/Pickers/GroupPicker, ProjectSettingsScreen, BoardScreen | done (fixtures: projectGroups, statePaging groupScenarios) |
| Prompts list and editor (Customize, Reset, Compare, variables) | screens/Prompts, app/prompt/[id] | Features/Prompts/* | done |
| Watcher form | screens/WatcherForm, lib/watcherDraft | Features/Watchers/WatcherFormScreen | done |
| Deep links (every `harness://` route above) | app/+native-intent, expo-router routes | Shell/DeepLink, Router, App/Destinations | done |
| Not ported (RN-only platform glue) | lib/keyboard, lib/device, ui/KeyboardAvoider | SwiftUI keyboard avoidance, UIDevice | n/a |

Release builds carry no placeholders or debug routes: every `-debugScreen` gallery, the file
viewer bench, the plugin probe and HighlightPreviewView are inside `#if DEBUG`, and Release
defines no DEBUG condition.

## Checks only a device can do

Simulators (and AXe) can't do these, so they stay manual, on a device:

- The chip-jump haptics.
- Rotating on the Browser tab (ResizeGate).
- Long-press-then-drag on the Browser tab.
- Smoothness (frame times) of a long transcript fling.
- Switching between two plugin tabs: this repo's only plugin tab is git:changes, which is now
  built in.
- Landscape on iPad: AXe's tree reads in the app's landscape points but its touches land in the
  device's portrait ones, and the keyboard still draws in portrait across the app.
