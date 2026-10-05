import Foundation

// The Browser tab's input model, timing glue included (wheel coalescing and the hidden input's
// 120-character reset), so the SwiftUI view only forwards touches and timestamps.
//
// Touch → page input for the Browser tab. The screencast frame is letterboxed into the stage; a
// finger on it maps to page CSS pixels (toPagePoint from @harness/shared/state), and gestures become
// the mouse / wheel / key events the service replays through CDP:
//   tap              → move + down + up (clickCount 1; a quick second tap nearby → 2)
//   pan              → wheel events (finger up = scroll down), scaled to page pixels
//   long-press + pan → mouse drag (down at the start, moves, up at the end), for sliders, selection…
// Pure and clock-injected so it can be tested without a screen.
//
// Clock mapping: nothing here reads a clock or owns a timer. TouchGesture takes the event time
// (epoch or monotonic ms, as long as one gesture uses one clock) with every call. Wheel batching
// is WheelCoalescer's `deadline` + `tick(now:)` rather than a timer of its own: the view schedules
// one wake-up at `deadline` (a Task sleep, a display link) and calls `tick`.

/// A gesture recognizer that turns one finger's begin/move/end into BrowserInput, driven by
/// explicit points (stage coordinates) and timestamps (ms). Feed it from a SwiftUI
/// `DragGesture(minimumDistance: 0)`: `begin` on the first change, `move` on each change, `end` on
/// `.onEnded`, `cancel` when the system takes the touch.
public final class TouchGesture {
    public struct Point: Sendable, Equatable, Codable {
        public var x: Double
        public var y: Double
        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    public enum Mode: String, Sendable, Equatable, Codable {
        case idle, pending, pan, drag
    }

    public struct Options {
        /// Local point (stage coordinates) → page CSS pixels, or nil outside the drawn frame
        public var toPage: (Point) -> Point?
        /// Page CSS pixels per stage point (page width / drawn width)
        public var scale: () -> Double
        /// Movement below this (stage points) is still a tap
        public var slop: Double
        /// Holding this long before moving turns a pan into a drag
        public var longPressMs: Double
        /// Two taps within this window (and within doubleTapSlop) make a double click
        public var doubleTapMs: Double
        public var doubleTapSlop: Double

        public init(
            toPage: @escaping (Point) -> Point?, scale: @escaping () -> Double, slop: Double = 8, longPressMs: Double = 450,
            doubleTapMs: Double = 320, doubleTapSlop: Double = 24
        ) {
            self.toPage = toPage
            self.scale = scale
            self.slop = slop
            self.longPressMs = longPressMs
            self.doubleTapMs = doubleTapMs
            self.doubleTapSlop = doubleTapSlop
        }
    }

    private struct Tap {
        var at: Double
        var p: Point
        var count: Int
    }

    private var mode: Mode = .idle
    private var start = Point(x: 0, y: 0)
    private var startAt: Double = 0
    private var last = Point(x: 0, y: 0)
    private var lastPage: Point?
    private var lastTap: Tap?
    private let opts: Options

    public init(_ options: Options) {
        opts = options
    }

    public var state: Mode { mode }

    public func begin(_ p: Point, at: Double) -> [BrowserInput] {
        mode = .pending
        start = p
        last = p
        startAt = at
        lastPage = opts.toPage(p)
        return []
    }

    public func move(_ p: Point, at: Double) -> [BrowserInput] {
        if mode == .idle { return [] }
        var out: [BrowserInput] = []
        if mode == .pending {
            if hypot(p.x - start.x, p.y - start.y) < opts.slop { return [] }
            if at - startAt >= opts.longPressMs, let s = lastPage {
                mode = .drag
                out.append(mouse(.move, s))
                out.append(mouse(.down, s, button: .left, clickCount: 1))
            } else {
                mode = .pan
            }
        }
        if mode == .pan {
            let k = opts.scale()
            let dx = (last.x - p.x) * k
            let dy = (last.y - p.y) * k
            let at2 = opts.toPage(p) ?? lastPage
            // `dx || dy` in JS: NaN and ±0 are falsy, and the test is on the unrounded deltas.
            if let at2, truthy(dx) || truthy(dy) {
                out.append(.mouse(.init(action: .wheel, x: at2.x, y: at2.y, deltaX: JSCompat.round(dx), deltaY: JSCompat.round(dy))))
            }
            if let at2 { lastPage = at2 }
        } else if mode == .drag {
            if let page = opts.toPage(p) {
                lastPage = page
                out.append(mouse(.move, page))
            }
        }
        last = p
        return out
    }

    public func end(_ p: Point, at: Double) -> [BrowserInput] {
        let ended = mode
        mode = .idle
        if ended == .drag {
            guard let lastPage else { return [] }
            return [mouse(.up, opts.toPage(p) ?? lastPage, button: .left, clickCount: 1)]
        }
        if ended != .pending { return [] }
        guard let page = opts.toPage(p) else { return [] }
        var count = 1
        if let prev = lastTap, at - prev.at <= opts.doubleTapMs, hypot(p.x - prev.p.x, p.y - prev.p.y) <= opts.doubleTapSlop {
            count = min(prev.count + 1, 3)
        }
        lastTap = Tap(at: at, p: p, count: count)
        return [mouse(.move, page), mouse(.down, page, button: .left, clickCount: count), mouse(.up, page, button: .left, clickCount: count)]
    }

    /// The system took the touch (e.g. a sheet opened): release a held button.
    public func cancel() -> [BrowserInput] {
        let ended = mode
        mode = .idle
        if ended == .drag, let lastPage { return [mouse(.up, lastPage, button: .left, clickCount: 1)] }
        return []
    }
}

private func truthy(_ x: Double) -> Bool { x != 0 && !x.isNaN }

private func mouse(_ action: MouseAction, _ p: TouchGesture.Point, button: MouseButton? = nil, clickCount: Int? = nil) -> BrowserInput {
    .mouse(.init(action: action, x: p.x, y: p.y, button: button, clickCount: clickCount))
}

// ---------------------------------------------------------------------------
// Wheel coalescing
// ---------------------------------------------------------------------------

/// Wheel events arrive at touch rate; coalesce them to ~30/s. Wheels are summed (at the latest
/// point) until `deadline`; any other input flushes the pending wheel first so ordering holds.
///
/// Timing: the first wheel of a batch makes `push` set `deadline = now + intervalMs`, and the
/// view calls `tick(now:)` at or after it (a sleeping Task, say). `tick` before the deadline
/// returns nothing, so an early wake-up is harmless. Call `flush()` when the view goes away if
/// pending scroll should still be sent.
/// A flush disarms the deadline, so the next wheel starts a fresh 33 ms.
public struct WheelCoalescer: Sendable {
    private struct Pending: Sendable {
        var x: Double
        var y: Double
        var dx: Double
        var dy: Double
    }

    public let intervalMs: Double
    private var pending: Pending?
    /// When the pending wheel is due (ms, the clock `push` was given), or nil when no timer is armed.
    public private(set) var deadline: Double?

    public init(intervalMs: Double = 33) {
        self.intervalMs = intervalMs
    }

    /// Route a gesture's inputs: returns what to send now. Wheels are held back.
    public mutating func push(_ inputs: [BrowserInput], at now: Double) -> [BrowserInput] {
        var out: [BrowserInput] = []
        for input in inputs {
            if case let .mouse(m) = input, m.action == .wheel {
                let w = pending ?? Pending(x: m.x, y: m.y, dx: 0, dy: 0)
                pending = Pending(x: m.x, y: m.y, dx: w.dx + (m.deltaX ?? 0), dy: w.dy + (m.deltaY ?? 0))
                if deadline == nil { deadline = now + intervalMs }
            } else {
                if pending != nil { out += flush() }
                out.append(input)
            }
        }
        return out
    }

    /// The timer fired: the summed wheel when `now` has reached the deadline, else nothing.
    public mutating func tick(now: Double) -> [BrowserInput] {
        guard let deadline, now >= deadline else { return [] }
        return flush()
    }

    /// Send the pending wheel now (and disarm the timer). A batch that summed to zero sends nothing.
    public mutating func flush() -> [BrowserInput] {
        deadline = nil
        guard let w = pending else { return [] }
        pending = nil
        guard truthy(w.dx) || truthy(w.dy) else { return [] }
        return [.mouse(.init(action: .wheel, x: w.x, y: w.y, deltaX: w.dx, deltaY: w.dy))]
    }
}

// ---------------------------------------------------------------------------
// Keyboard: a hidden text field's text changes → text inserts and Backspaces
// ---------------------------------------------------------------------------

public enum BrowserTyping {
    public struct Delta: Sendable, Equatable, Codable {
        /// Backspaces to send: UTF-16 code units, as JS `.length` counts them
        public var deletes: Int
        public var insert: String
        public init(deletes: Int, insert: String) {
            self.deletes = deletes
            self.insert = insert
        }
    }

    /// What changed between two values of the hidden input (autocorrect replacements included).
    ///
    /// Compares UTF-16 code units, as the page counts them. When the shared prefix ends inside a
    /// surrogate pair (two emoji with the same high surrogate), the insert would start with a lone
    /// low surrogate; a Swift String can't hold one, so it becomes U+FFFD. `deletes` still counts
    /// code units.
    public static func textDelta(_ prev: String, _ next: String) -> Delta {
        let a = Array(prev.utf16)
        let b = Array(next.utf16)
        var i = 0
        while i < a.count, i < b.count, a[i] == b[i] { i += 1 }
        return Delta(deletes: a.count - i, insert: String(decoding: b[i...], as: UTF16.self))
    }

    private static let namedKeys: Set<String> = ["Backspace", "Enter", "Tab", "Escape"]

    /// Press and release a named key ("Backspace", "Enter", "Tab", "Escape"); [] for anything else.
    /// "toString", "constructor" and the like are [] too, like any unnamed key.
    public static func keyPress(_ key: String) -> [BrowserInput] {
        guard namedKeys.contains(key) else { return [] }
        return [.key(.init(action: .down, key: key, code: key)), .key(.init(action: .up, key: key, code: key))]
    }

    public static func textChangeInputs(_ prev: String, _ next: String) -> [BrowserInput] {
        let d = textDelta(prev, next)
        var out: [BrowserInput] = []
        for _ in 0..<d.deletes { out += keyPress("Backspace") }
        if !d.insert.isEmpty { out.append(.text(text: d.insert)) }
        return out
    }

    /// The hidden field's bookkeeping on each text change: diff against what was
    /// last typed, and once the text passes `limit` UTF-16 units, clear it (the page already has
    /// it) so the diff stays short.
    public struct HiddenInput: Sendable, Equatable {
        public private(set) var typed: String = ""
        public let limit: Int

        public init(limit: Int = 120) {
            self.limit = limit
        }

        /// The field's text changed to `next`: what to send, and whether to clear the field.
        public mutating func change(to next: String) -> (inputs: [BrowserInput], clear: Bool) {
            let inputs = BrowserTyping.textChangeInputs(typed, next)
            typed = next
            if next.utf16.count > limit {
                typed = ""
                return (inputs, true)
            }
            return (inputs, false)
        }
    }
}

// ---------------------------------------------------------------------------
// Resize: only after the subscription is confirmed, only real size changes
// ---------------------------------------------------------------------------

/// The service restarts the screencast on every real viewport change, and overlapping restarts
/// (or one that races the subscribe) leave the tab without frames. So send nothing until the first
/// browser.state for the session confirms the subscription, then only sizes that differ from the
/// last one sent. Call reset() for a new session or after a reconnect.
///
/// A tab with a size (BrowserState.size) follows a stage only while it's responsive, and only the
/// stage of the viewer that switched that on (`sizeOwner`): feed every state to `follow`, and
/// `take` sends nothing while another viewer (or nobody) drives the tab. A state without a size
/// (a service from before per-tab sizes) leaves every viewer driving it, as before.
///
/// (Debounce `take` by 250 ms after layout and 100 ms after confirm; that belongs in the view,
/// e.g. `.task(id: size) { try await Task.sleep(for: .milliseconds(250)); … }`.)
public struct ResizeGate: Sendable, Equatable {
    private var subscribed = false
    private var lastSent: (Int, Int)?
    /// This viewer's stage size drives the tab.
    public private(set) var drives = true

    public init() {}

    public static func == (a: Self, b: Self) -> Bool {
        a.subscribed == b.subscribed && a.drives == b.drives && a.lastSent?.0 == b.lastSent?.0 && a.lastSent?.1 == b.lastSent?.1
    }

    public mutating func reset() {
        subscribed = false
        lastSent = nil
        drives = true
    }

    /// A browser.state for the tab shown: whether this viewer drives its size now. Losing it
    /// forgets the last size sent, so taking it back sends the stage again even when it's the same
    /// size it was (the tab has followed someone else's stage meanwhile).
    public mutating func follow(_ state: BrowserState) {
        drives = state.size == nil || state.ownsSize
        if !drives { lastSent = nil }
    }

    /// The Responsive switch turned on from this viewer: the input carrying its stage size, which
    /// counts as sent (the state that follows makes this viewer the owner, and its stage is
    /// already the tab's size). Sizes that can't be an Int are left off.
    public mutating func responsiveOn(width: Double, height: Double) -> BrowserInput {
        guard let w = Int(exactly: JSCompat.round(width)), let h = Int(exactly: JSCompat.round(height)), w > 0, h > 0 else {
            return .responsive(on: true, width: nil, height: nil)
        }
        lastSent = (w, h)
        return .responsive(on: true, width: w, height: h)
    }

    /// A browser.state arrived; true the first time (schedule a resize now).
    public mutating func confirm() -> Bool {
        if subscribed { return false }
        subscribed = true
        return true
    }

    /// The resize to send for this stage size, or nil. NaN and infinite sizes can't be an Int, so
    /// they're nil.
    public mutating func take(width: Double, height: Double) -> BrowserInput? {
        guard subscribed, drives else { return nil }
        guard let w = Int(exactly: JSCompat.round(width)), let h = Int(exactly: JSCompat.round(height)) else { return nil }
        if w <= 0 || h <= 0 { return nil }
        if let l = lastSent, l == (w, h) { return nil }
        lastSent = (w, h)
        return .resize(width: w, height: h)
    }
}
