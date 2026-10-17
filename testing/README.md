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
