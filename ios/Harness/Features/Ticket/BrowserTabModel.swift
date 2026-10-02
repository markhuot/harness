import HarnessKit
import SwiftUI
import UIKit

/// The Browser tab's state and timing glue: the subscription, the latest
/// decoded frame, live/idle, the resize gate and its debounce, wheel coalescing, and the hidden
/// field's typing buffer. The input rules themselves are HarnessKit's (TouchGesture,
/// WheelCoalescer, BrowserTyping, ResizeGate); this class feeds them touches and clock readings.
@MainActor
@Observable
final class BrowserTabModel {
    /// A decoded screencast frame. `width`/`height` are the page's CSS size from browser.frame
    /// (what touches map to), not the image's pixel size.
    struct Frame {
        let image: UIImage
        let width: Double
        let height: Double
    }

    private(set) var state: BrowserState?
    private(set) var frame: Frame?
    private(set) var live = false
    /// The stage's size (points), from the view's geometry.
    private(set) var stage: CGSize = .zero

    @ObservationIgnored private var send: (BrowserInput) -> Void = { _ in }
    @ObservationIgnored private var lastFrameAt: Double = 0
    @ObservationIgnored private var gate = ResizeGate()
    @ObservationIgnored private var resizeTask: Task<Void, Never>?
    @ObservationIgnored private var wheel = WheelCoalescer()
    @ObservationIgnored private var wheelTask: Task<Void, Never>?
    @ObservationIgnored private var typing = BrowserTyping.HiddenInput()
    // Frames arrive faster than they decode on a slow phone: decode one at a time, and only the
    // newest that arrived meanwhile.
    @ObservationIgnored private var decoding = false
    @ObservationIgnored private var pendingFrame: (data: String, width: Int, height: Int)?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private lazy var gesture = TouchGesture(.init(
        toPage: { [weak self] p in self?.toPage(p) },
        scale: { [weak self] in self?.pageScale() ?? 1 }))

    /// What's drawn: the frame letterboxed into the stage (zero before the first frame).
    var drawn: Format.Rect {
        guard let frame else { return Format.Rect(x: 0, y: 0, w: 0, h: 0) }
        return Format.fitRect(boxW: stage.width, boxH: stage.height, w: frame.width, h: frame.height)
    }

    /// Nothing to show at all: no frame and no state (the session has no browser).
    var empty: Bool { frame == nil && state == nil }

    // MARK: Subscription

    /// One subscription's lifetime: run it in `.task(id:)` keyed on the session, the store's epoch
    /// and its socket generation. Returns once the task is cancelled, after unsubscribing.
    func run(sessionId: String, store: BoardStore, client: HarnessClient?) async {
        generation += 1
        state = nil
        frame = nil
        pendingFrame = nil
        gate.reset()
        send = { [weak store] input in store?.sendBrowserInput(sessionId, input) }
        store.subscribeBrowser(sessionId)
        let off = store.onEvent { [weak self] event in
            guard let self else { return }
            switch event {
            case let .browserFrame(id, data, width, height) where id == sessionId:
                self.lastFrameAt = Self.now()
                if !self.live { self.live = true }
                self.receiveFrame(data: data, width: width, height: height)
            case let .browserState(id, s) where id == sessionId:
                self.state = s
                if self.gate.confirm() { self.scheduleResize(ms: 100) }
            default: break
            }
        }
        if let client, let s = try? await client.browserState(sessionId), !Task.isCancelled { state = s }
        // Live = a frame within the last 2 s, checked twice a second.
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(500))
            let isLive = Self.now() - lastFrameAt < 2000
            if isLive != live { live = isLive }
        }
        off()
        store.unsubscribeBrowser(sessionId)
        resizeTask?.cancel()
        wheelTask?.cancel()
        wheel = WheelCoalescer()
        _ = gesture.cancel()
    }

    /// navigate() answered with the new state.
    func apply(_ s: BrowserState) {
        state = s
    }

    private func receiveFrame(data: String, width: Int, height: Int) {
        pendingFrame = (data, width, height)
        guard !decoding else { return }
        decodeNext()
    }

    private func decodeNext() {
        guard let next = pendingFrame else { return }
        pendingFrame = nil
        decoding = true
        let gen = generation
        Task {
            // base64 JPEG, or PNG when the data starts "iVBOR"; UIImage reads either. Decoded and
            // prepared off the main thread, so the swap is a pointer change with no blank frame.
            let image = await Task.detached(priority: .userInitiated) { () -> UIImage? in
                guard let bytes = Data(base64Encoded: next.data), let img = UIImage(data: bytes) else { return nil }
                return img.preparingForDisplay() ?? img
            }.value
            decoding = false
            if gen == generation, let image {
                frame = Frame(image: image, width: Double(next.width), height: Double(next.height))
            }
            decodeNext()
        }
    }

    // MARK: Resize

    /// The stage was laid out (first layout, rotation, keyboard): resize the page viewport once
    /// the subscription is confirmed, debounced.
    func setStage(_ size: CGSize) {
        guard size != stage else { return }
        stage = size
        scheduleResize(ms: 250)
    }

    private func scheduleResize(ms: Int) {
        resizeTask?.cancel()
        resizeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(ms))
            guard let self, !Task.isCancelled else { return }
            if let r = self.gate.take(width: self.stage.width, height: self.stage.height) { self.send(r) }
        }
    }

    // MARK: Touch → page input

    private func toPage(_ p: TouchGesture.Point) -> TouchGesture.Point? {
        guard let frame else { return nil }
        let page = Format.toPagePoint(.init(x: p.x, y: p.y), drawn: drawn, page: .init(width: frame.width, height: frame.height))
        return page.map { TouchGesture.Point(x: $0.x, y: $0.y) }
    }

    private func pageScale() -> Double {
        let d = drawn
        guard let frame, d.w != 0 else { return 1 }
        return frame.width / d.w
    }

    /// Touch phases from the stage (points in stage coordinates, `at` = the touch's timestamp in ms
    /// on the system uptime clock, which `now()` also reads).
    func touchBegan(_ p: CGPoint, at: Double) {
        dispatch(gesture.begin(.init(x: p.x, y: p.y), at: at))
    }

    func touchMoved(_ p: CGPoint, at: Double) {
        dispatch(gesture.move(.init(x: p.x, y: p.y), at: at))
    }

    func touchEnded(_ p: CGPoint, at: Double) {
        let out = gesture.end(.init(x: p.x, y: p.y), at: at)
        if out.contains(where: { if case let .mouse(m) = $0 { m.action == .down } else { false } }) { haptic(.tap) }
        dispatch(out)
    }

    func touchCancelled() {
        dispatch(gesture.cancel())
    }

    private func dispatch(_ inputs: [BrowserInput]) {
        guard !inputs.isEmpty else { return }
        for input in wheel.push(inputs, at: Self.now()) { send(input) }
        armWheel()
    }

    /// One wake-up at the coalescer's deadline (~30 wheels a second); an early wake-up or a batch
    /// armed meanwhile re-arms.
    private func armWheel() {
        guard let deadline = wheel.deadline, wheelTask == nil else { return }
        wheelTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(max(0, deadline - Self.now()).rounded(.up))))
            guard let self, !Task.isCancelled else { return }
            self.wheelTask = nil
            for input in self.wheel.tick(now: Self.now()) { self.send(input) }
            self.armWheel()
        }
    }

    // MARK: Keyboard

    /// The hidden field's text changed; returns true when the field should be cleared.
    func typed(_ next: String) -> Bool {
        let (inputs, clear) = typing.change(to: next)
        for input in inputs { send(input) }
        return clear
    }

    /// Return, Tab, or Backspace on an empty field.
    func press(_ key: String) {
        for input in BrowserTyping.keyPress(key) { send(input) }
    }

    /// Back / Forward / Reload.
    func command(_ input: BrowserInput) {
        send(input)
    }

    /// Milliseconds on the system uptime clock, the same clock as UITouch.timestamp.
    static func now() -> Double {
        ProcessInfo.processInfo.systemUptime * 1000
    }
}
