# testing

`bun run testing` runs the whole gate: nothing lands on `main` until it passes on the result. Its commands: `l0`, `mac`, `ios`, `walk`, `stress`, `lint`, and `fast` (everything that needs no simulator or Electron; `bun run test` runs it).
`bun run testing lint` fails a test that imports another test file or a data folder.

## One heavy run at a time (`queue-lock.ts`)

Every command except `lint`, `l0` and `queue` takes the testing lock (`~/.harness/tmp/testing-lock`,
shared by all worktrees). A run that finds it taken queues in arrival order, prints its position, and
starts by itself with `testing: your turn started`; it never times out. A holder or waiter that is killed
or crashes is dropped by its PID and start time, and SIGINT/SIGTERM kill the run's children before
letting go. After the previous holder lets go, the next run waits up to 60 seconds while xcodebuild,
simulator boot/shutdown, Electron or a high load average (only within that minute) persists, then goes
regardless. `bun run testing queue` shows the holder and waiters. Commands the gate runs inherit
`HARNESS_TESTING_LOCKED`, so a nested `bun run testing` doesn't queue behind its parent. The lock is
always taken before a simulator slot.

## The shared world (`testing/world`)

One small, fixed set of data the screens are drawn from (layers L4 and L5 only; logic tests build
their own minimal data). It is typed TypeScript checked against `shared/src/protocol.ts`, so a
protocol change breaks typecheck here instead of producing a blank screen. Everything is dated
relative to `NOW` (2026-03-14 15:00 UTC), in the UTC zone and the `en_US` locale.

- `bun testing/world/generate.ts` writes `world.json`, which the Swift side loads. It is committed;
  `world.test.ts` fails when it differs from a fresh generation. `bun run testing ios` regenerates it.
- `world.test.ts` checks the world's own invariants (ids unique, every ticket's project exists,
  every status present).
- `testing/swift` (`WorldDecodeTests`) decodes all of `world.json` through the real HarnessKit models.

Editing the world changes both clients' renders; that is the point. After a change, re-record the
iPhone and iPad references on purpose (below) and read the diff.

## Mac components (`testing/mac`, `bun run testing mac`)

React views under happy-dom, against a `FakeClient`: the real `HarnessClient` with its transport
replaced, answering from the world. Run as a bun process of their own (the DOM globals would
leak into the service tests). The clock, time zone and locale are pinned in `setup.ts`. Tests find
things the way a person does (roles, labels, visible text) and wait on the app's own signals, never
on time. A debounce is moved with `jest.useFakeTimers()`.

## iPhone and iPad (`testing/ios`, `bun run testing ios`)

The screens render from the world in a test bundle hosted by the app (`HarnessScreenTests` in
`ios/project.yml`: the screens live in the app target, so a hostless bundle can't render them),
through the real `HarnessClient` and `BoardStore` with only the transport (`WorldTransport`) and the
socket (`WorldSocket`) replaced. A request the world has no route for fails the test.

- Images are compared in `testing/ios/references/{iphone,ipad,duo}/` with a per-pixel channel tolerance
  and a budget of differing pixels (`ReferenceImages.swift`). They are pinned to the iOS 27.0
  runtime (27.1 for the iPhone Duo).
- The iPad references are recorded with the simulator in **Settings > Multitasking & Gestures >
  Full Screen Apps** (a fresh iPad simulator starts in Windowed Apps). The renderer checks the iPad's
  safe area (top 32, bottom 25 in portrait) before it draws and fails with the values it found
  instead of drawing every screen at another offset. Put the simulator back; don't re-record.
- `--record` writes references. Nothing else does, and a missing reference fails the test.
- A failure writes `<name>.actual.png` and `<name>.diff.png` to a temp directory and prints the
  paths. `--out=dir` also writes every rendered image there.
- One `xcodebuild build-for-testing` builds the app and the bundle for both devices into
  `testing/.build`, stamped with a hash of its sources (`stamp.json`): an unchanged tree reuses it, a
  changed one rebuilds. The walkthrough reuses the same products. Tests then run per device under
  `bun run sim with-lock`. `--only=ScreenTests/testBoard` runs one.
- Animations are off, and spinners that repeat forever are frozen where they stand so a busy ticket
  can still settle. A render waits for the display's frames to stop changing and the transport to
  have nothing in flight, never for a fixed delay.

## The walkthrough (`testing/walk`, `bun run testing walk`)

One journey through the real apps, last in the gate: the service (dummy driver, port 0, a temp
home), the built Mac app, and the iPhone and iPad apps from the same build-for-testing as L4 iOS.
Nine steps, each building on the last, and each something only the real apps together can show:
launch the Mac app; pair both phones by link; a ticket made on the service shows in Planning on all
three; approve its plan with a click and watch the dummy session stream in on all three; raise the
iPhone's keyboard and check the composer rides above it; open a file from the Mac's palette, see the
editor draw it, and Save an edit into the ticket's worktree through the service; open a terminal
(a real shell answers a command sent over `/ws`) and pop it out into its own window and back (the
renderer↔main IPC the L4 layers can't reach); relaunch each app and check the state survived; and
one chief of staff step (8a), with the classifier off and the dummy driver playing the chief
(`/tools [...]` in a message makes it call those tools): the board's title-bar button opens the
group's chief, which creates a spike and a build ticket (cards in the chat on the Mac and, through a
deep link, on both phones), and the title-bar count pill agrees with the service.

The logic behind the steps is tested lower down, not here: the New Ticket form and the chief's
composer (Mac views), the editor's dirty mark, Save and a failed write (`mac/file.test.tsx`) and the
file routes (`service-api/files.test.ts`), pane widths, groups, wrap and the view menu (L0 and Mac
views), and the chief's scope, can-unblock, hand-off, schedules and badge counts (service). Nothing
types into the Mac app but the palette's query: tickets, chief messages and the shell's command go
in through the API, so no step depends on which window has the keyboard focus.

- Data for the journey is `testing/world/walk.ts` (a checkout, the ticket, the dummy driver's
  markers), seeded through the real API.
- Every wait is on an observable (a `/ws` event, a DOM mutation over DevTools, an accessibility
  label through AXe, a process's output) and has a deadline that names the step and the last state
  seen. There are no sleeps or fixed pauses. A tap is repeated only when two looks at the screen after it show the target still there and nothing changed, and Home is checked by the app's saved state, not a pause.
- `walk/run.ts` builds the Mac app and the iOS app once, then takes the iPhone and iPad locks in a
  fixed order (`bun run sim with-lock`) and runs `walk/main.ts` inside them. The simulators are left
  booted; only the app installs are removed.
- Every process the run starts is written to `testing/.walk/runs/<pid>.pids`. The run kills them on
  the way out, on SIGINT and on SIGTERM, and the next run reaps what a killed one left.
- `--out=dir` sets where the screenshots go (default `testing/.walk/shots`): named, fixed points
  (`01-mac-board`, `04-transcript-iphone`, …). They are not compared with anything.
- The Mac app runs with Chromium's background throttling off and focus emulated (`lib/mac.ts`), so a
  simulator window covering it doesn't stop its animation frames, which the waits and the editor
  run on. A Mac wait that times out also prints the page's focus, visibility and focused element.
- The drivers (`lib/daemon.ts`, `lib/cdp.ts` and `lib/mac.ts`, `lib/ios.ts`) are shared: other
  tests that need the real service, the real Mac app or a simulator use them instead of a copy.
- The terminal is a canvas, so what the shell printed is read on the service (`terminal.snapshot`
  and `terminal.output` on `/ws`), not from the DOM.
