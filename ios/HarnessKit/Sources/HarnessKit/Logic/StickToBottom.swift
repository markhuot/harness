import Foundation

// A port of shared/src/state/stickToBottom.ts (nextPinned: whether a transcript or summaries list
// should keep following new content), plus stickStep: which scroll events may unpin or re-pin, and
// when to jump to the end.
//
// Scroll events don't say who caused them: the app's own jump to the bottom, the scroll view
// clamping after content shrinks, a list re-measuring rows, or the user. Only the user moves the
// view *up*, away from the bottom, so that's the one signal that unpins. Content growing or the
// viewport shrinking (keyboard, a taller composer) leaves the offset alone or moves it down, which
// keeps the current state. Getting back near the bottom re-pins.
//
// On iOS that isn't enough: UIScrollView (under SwiftUI's ScrollView too) nudges the offset up by
// itself while a list lays out, so only a gesture (a drag, the momentum after it) may unpin or
// re-pin. Reading a nudge as the user scrolling away is what left the transcript stranded mid-list.

/// One scroll position, as a SwiftUI ScrollView's `onScrollGeometryChange` reports it.
public struct ScrollMetrics: Codable, Equatable, Sendable {
    /// Distance scrolled from the top (contentOffset.y).
    public var offset: Double
    /// Full scrollable height (contentSize.height).
    public var contentHeight: Double
    /// Visible height (containerSize.height).
    public var viewportHeight: Double

    public init(offset: Double, contentHeight: Double, viewportHeight: Double) {
        self.offset = offset
        self.contentHeight = contentHeight
        self.viewportHeight = viewportHeight
    }

    /// From ScrollGeometry's fields. SwiftUI's contentOffset.y is `-top` at the top when the
    /// content has insets, the bottom inset extends the scrollable range, and containerSize is the
    /// frame less both insets, so they fold into the content and the viewport alike to keep
    /// "distance from the bottom" zero exactly at the end.
    public init(contentOffsetY: Double, contentHeight: Double, containerHeight: Double, topInset: Double = 0, bottomInset: Double = 0) {
        self.init(offset: contentOffsetY + topInset, contentHeight: contentHeight + topInset + bottomInset,
                  viewportHeight: containerHeight + topInset + bottomInset)
    }
}

/// The pinned state and what the gesture is doing.
public struct Stick: Codable, Equatable, Sendable {
    public var pinned: Bool
    /// Finger on the list: don't move it.
    public var dragging: Bool
    /// A drag or its momentum is under way: scroll events are the user's.
    public var gesture: Bool
    public var lastOffset: Double

    public init(pinned: Bool, dragging: Bool, gesture: Bool, lastOffset: Double) {
        self.pinned = pinned
        self.dragging = dragging
        self.gesture = gesture
        self.lastOffset = lastOffset
    }
}

/// What happened to the scroll view. The cases are UIScrollView's delegate callbacks;
/// `StickToBottom.events(from:to:metrics:)` derives them from SwiftUI scroll phases.
public enum StickEvent: Decodable, Equatable, Sendable {
    /// The offset moved (onScrollGeometryChange).
    case scroll(ScrollMetrics)
    case beginDrag(ScrollMetrics)
    /// `velocity`: the drag's vertical release velocity; zero means no momentum phase follows.
    case endDrag(velocity: Double, ScrollMetrics)
    case momentumBegin
    case momentumEnd(ScrollMetrics)
    /// A status-bar tap. SwiftUI has no callback for it, so only an app that wires its own
    /// (a jump-to-top control) sends this.
    case scrollToTop
    /// The content grew or shrank, or the viewport was laid out again.
    case resize

    private enum CodingKeys: String, CodingKey { case type, velocity }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        func metrics() throws -> ScrollMetrics { try ScrollMetrics(from: decoder) }
        switch type {
        case "scroll": self = .scroll(try metrics())
        case "beginDrag": self = .beginDrag(try metrics())
        case "endDrag": self = .endDrag(velocity: try c.decode(Double.self, forKey: .velocity), try metrics())
        case "momentumBegin": self = .momentumBegin
        case "momentumEnd": self = .momentumEnd(try metrics())
        case "scrollToTop": self = .scrollToTop
        case "resize": self = .resize
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown StickEvent \(type)")
        }
    }
}

/// stickStep's result: the state after an event, and whether to jump to the end now.
public struct StickStep: Codable, Equatable, Sendable {
    public var stick: Stick
    public var follow: Bool

    public init(stick: Stick, follow: Bool) {
        self.stick = stick
        self.follow = follow
    }
}

/// SwiftUI's `ScrollPhase`, mirrored so HarnessKit stays free of SwiftUI.
public enum StickScrollPhase: Sendable, Equatable {
    case idle, tracking, interacting, decelerating, animating
}

/// A SwiftUI view reports geometry and phases, so `events(from:to:metrics:)` stands in for UIKit's
/// drag and momentum callbacks, and the release velocity collapses to "does a decelerating phase
/// follow".
public enum StickToBottom {
    /// Within this many points of the bottom counts as "at the bottom" for re-pinning.
    public static let threshold = 48.0

    /// Following the bottom, nothing in progress.
    public static let stuck = Stick(pinned: true, dragging: false, gesture: false, lastOffset: 0)

    public static func distanceFromBottom(_ m: ScrollMetrics) -> Double {
        m.contentHeight - m.offset - m.viewportHeight
    }

    /// The next pinned state after a scroll event, given the offset from the previous event.
    public static func nextPinned(_ pinned: Bool, prevOffset: Double, _ m: ScrollMetrics, threshold: Double = threshold) -> Bool {
        let distance = distanceFromBottom(m)
        // A clamp after content shrinks also moves the offset up, but lands on the bottom (distance ~0).
        if m.offset < prevOffset - 1 && distance > 2 { return false }
        if distance <= threshold { return true }
        return pinned
    }

    /// The state after an event, and whether to jump to the end now.
    public static func stickStep(_ s: Stick, _ e: StickEvent) -> StickStep {
        func track(_ x: Stick, _ m: ScrollMetrics) -> Stick {
            var t = x
            if x.gesture { t.pinned = nextPinned(x.pinned, prevOffset: x.lastOffset, m) }
            t.lastOffset = m.offset
            return t
        }
        func follows(_ x: Stick) -> Bool { x.pinned && !x.dragging }
        // The gesture is over: re-follow if it ended at the bottom. iOS also reports a momentum end
        // after a programmatic jump, which isn't a gesture and changes nothing.
        func settle(_ x: Stick, _ m: ScrollMetrics) -> StickStep {
            var t = track(x, m)
            guard t.gesture else { return StickStep(stick: t, follow: false) }
            t.gesture = false
            return StickStep(stick: t, follow: follows(t))
        }
        switch e {
        case let .scroll(m):
            return StickStep(stick: track(s, m), follow: false)
        case let .beginDrag(m):
            var x = s
            x.dragging = true
            x.gesture = true
            return StickStep(stick: track(x, m), follow: false)
        case let .endDrag(velocity, m):
            var x = s
            x.dragging = false
            let t = track(x, m)
            return velocity != 0 ? StickStep(stick: t, follow: false) : settle(t, m)
        case .momentumBegin:
            var x = s
            x.gesture = true
            return StickStep(stick: x, follow: false)
        case let .momentumEnd(m):
            return settle(s, m)
        case .scrollToTop:
            var x = s
            x.pinned = false
            return StickStep(stick: x, follow: false)
        case .resize:
            return StickStep(stick: s, follow: follows(s))
        }
    }

    /// The UIKit-style events a SwiftUI scroll phase change stands for (`onScrollPhaseChange`),
    /// with the geometry at the change. A finger landing starts a drag; lifting it ends the drag,
    /// with momentum when the view goes on decelerating; the deceleration ending (or a finger
    /// catching it) ends the momentum. `tracking` (finger down, not moving yet) and `animating`
    /// (a programmatic scroll) aren't gestures and send nothing.
    public static func events(from old: StickScrollPhase, to new: StickScrollPhase, metrics m: ScrollMetrics) -> [StickEvent] {
        if old == new { return [] }
        var events: [StickEvent] = []
        if old == .interacting {
            if new == .decelerating {
                // Any nonzero velocity means "momentum follows"; stickStep reads nothing else.
                return [.endDrag(velocity: 1, m), .momentumBegin]
            }
            events.append(.endDrag(velocity: 0, m))
        }
        if old == .decelerating { events.append(.momentumEnd(m)) }
        if new == .interacting { events.append(.beginDrag(m)) }
        return events
    }
}
