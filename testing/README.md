# testing

`bun run testing` runs the whole gate. Its commands: `l0`, `mac`, `ios`, `walk`, `stress`, `lint`.
Nothing here imports the old tests or their helpers (`bun run testing lint` enforces it).

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

- Images are compared in `testing/ios/references/{iphone,ipad}/` with a per-pixel channel tolerance
  and a budget of differing pixels (`ReferenceImages.swift`). They are pinned to the iOS 27.0
  runtime.
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
Seven steps, each building on the last: launch the Mac app; pair both phones by link; create a
ticket on the Mac and see it on both phones; approve its plan and watch the dummy session arrive on
all three; edit and save a file; open a terminal and pop it out into its own window (the
renderer↔main IPC the L4 layers can't reach); relaunch each app and check the state survived.

- Data for the journey is `testing/world/walk.ts` (a checkout, the ticket, the dummy driver's
  markers), seeded through the real API.
- Every wait is on an observable (a `/ws` event, a DOM mutation over DevTools, an accessibility
  label through AXe, a process's output) and has a deadline that names the step and the last state
  seen. There are no sleeps and no retries.
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
