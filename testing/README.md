# testing

`bun run testing` runs the whole gate: nothing lands on `main` until it passes on the result. Its commands: `l0`, `mac`, `ios`, `walk`, `stress`, `lint`, and `fast` (everything that needs no simulator or Electron; `bun run test` runs it).
`bun run testing lint` fails a test that imports another test file or a data folder.

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
Fifteen steps, each building on the last. Steps 1 to 7 are the app's basics: launch the Mac app;
pair both phones by link; create a ticket on the Mac and see it on both phones; approve its plan
and watch the dummy session arrive on all three; rename a project group in its settings; edit and
save a file; open a terminal and pop it out into its own window (the renderer↔main IPC the L4
layers can't reach); relaunch each app and check the state survived. Steps 8a to 8e are the chief
of staff, with the classifier off so its triage escalates instead of calling a model, and the dummy
driver playing the chief (`/tools [...]` in a message makes it call those tools): the board's
title-bar button opens the group's chief, which creates a spike and a build ticket (cards in the
chat on all three); a watcher's output lands in the All chief's Inbox with the title-bar count pill
agreeing with the service on Mac, iPhone and iPad; the chief answers a blocked ticket where
can-unblock is on, and is refused where it is off or the ticket is in another group; a reminder
fires on time and is handled by no run; a chief turned off hands its pending events to the next
owner, and turning chiefs off in Settings leaves them unowned and starts no run. The rules behind
these (scope, can-unblock, hand-off, schedules, badge counts) are tested at the service layer; the
steps only prove they hold through the real apps.

- Data for the journey is `testing/world/walk.ts` (a checkout, the ticket, the dummy driver's
  markers), seeded through the real API.
- Every wait is on an observable (a `/ws` event, a DOM mutation over DevTools, an accessibility
  label through AXe, a process's output) and has a deadline that names the step and the last state
  seen. There are no sleeps. A tap is repeated only when two looks at the screen after it show the target still there and nothing changed, and Home is checked by the app's saved state, not a pause.
- `walk/run.ts` builds the Mac app and the iOS app once, then takes the iPhone and iPad locks in a
  fixed order (`bun run sim with-lock`) and runs `walk/main.ts` inside them. The simulators are left
  booted; only the app installs are removed.
- Every process the run starts is written to `testing/.walk/runs/<pid>.pids`. The run kills them on
  the way out, on SIGINT and on SIGTERM, and the next run reaps what a killed one left.
- `--out=dir` sets where the screenshots go (default `testing/.walk/shots`): named, fixed points
  (`01-mac-board`, `04-transcript-iphone`, …). They are not compared with anything.
- The drivers (`lib/daemon.ts`, `lib/cdp.ts` and `lib/mac.ts`, `lib/ios.ts`) are shared: other
  tests that need the real service, the real Mac app or a simulator use them instead of a copy.
- The terminal is a canvas, so what the shell printed is read on the service (`terminal.snapshot`
  and `terminal.output` on `/ws`), not from the DOM.
