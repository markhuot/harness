import Foundation

// When the ticket hero (title, badges, actions) gets out of
// the way. A gesture that scrolls a tab's body forward hides it and one that scrolls back brings it
// back, like Safari's toolbars. The tab strip stays put, so the hero reads as the top of the page
// scrolling off.
//
// Only a gesture (a drag and the momentum after it) toggles it, and at most once: hiding the hero
// grows the tab body's viewport, and UIKit then clamps an offset that was near the bottom, which
// would otherwise read as scrolling back and bring the hero straight back.

/// The hero's state: hidden, and the gesture that may toggle it.
public struct Collapse: Codable, Equatable, Sendable {
    public var hidden: Bool
    /// A drag or its momentum is under way and hasn't toggled the hero yet.
    public var live: Bool
    /// Where the gesture's current run in one direction started.
    public var anchor: Double

    public init(hidden: Bool, live: Bool, anchor: Double) {
        self.hidden = hidden
        self.live = live
        self.anchor = anchor
    }
}

/// What happened to the tab body's scroll view (decoded from the fixtures' JSON).
public enum CollapseEvent: Decodable, Equatable, Sendable {
    case beginDrag(ScrollMetrics)
    case scroll(ScrollMetrics)
    /// `velocity`: the drag's release velocity; zero means no momentum phase follows.
    case endDrag(velocity: Double)
    case momentumEnd
    /// A status-bar tap, another tab, a tap on the current one, news on the ticket.
    case show

    private enum CodingKeys: String, CodingKey { case type, velocity }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "beginDrag": self = .beginDrag(try ScrollMetrics(from: decoder))
        case "scroll": self = .scroll(try ScrollMetrics(from: decoder))
        case "endDrag": self = .endDrag(velocity: try c.decode(Double.self, forKey: .velocity))
        case "momentumEnd": self = .momentumEnd
        case "show": self = .show
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown CollapseEvent \(type)")
        }
    }
}

public enum HeroCollapse {
    /// How far one gesture scrolls one way before the hero hides or comes back.
    public static let threshold = 24.0

    public static let shown = Collapse(hidden: false, live: false, anchor: 0)

    /// The offset inside the scrollable range: bounces past either end don't count as scrolling.
    private static func clamped(_ m: ScrollMetrics) -> Double {
        min(max(m.offset, 0), max(0, m.contentHeight - m.viewportHeight))
    }

    /// The state after an event. `heroHeight`: how much taller the tab body gets with the hero hidden.
    public static func step(_ s: Collapse, _ e: CollapseEvent, heroHeight: Double) -> Collapse {
        var next = s
        switch e {
        case let .beginDrag(m):
            next.live = true
            next.anchor = clamped(m)
        case let .endDrag(velocity):
            if velocity == 0 { next.live = false }
        case .momentumEnd:
            next.live = false
        case .show:
            return shown
        case let .scroll(m):
            guard s.live else { return s }
            let y = clamped(m)
            if s.hidden {
                if y <= 0 || s.anchor - y >= threshold { return Collapse(hidden: false, live: false, anchor: y) }
                next.anchor = max(s.anchor, y)
            } else {
                // With the hero gone the body must still scroll, or nothing could bring the hero back.
                let room = m.contentHeight - m.viewportHeight - heroHeight
                if y - s.anchor >= threshold && room >= threshold { return Collapse(hidden: true, live: false, anchor: y) }
                next.anchor = min(s.anchor, y)
            }
        }
        return next
    }

    /// The events a SwiftUI scroll phase change stands for (`onScrollPhaseChange`), with the
    /// geometry at the change: a finger landing starts a drag; lifting it ends the drag, with
    /// momentum when the view goes on decelerating; the deceleration ending (or a finger catching
    /// it) ends the momentum. `tracking` and `animating` aren't gestures and send nothing, except
    /// that an animated scroll which settles at the top is how a status-bar tap shows up (SwiftUI
    /// has no scroll-to-top callback), so it sends `show`, as a scroll-to-top does.
    public static func events(from old: StickScrollPhase, to new: StickScrollPhase, metrics m: ScrollMetrics) -> [CollapseEvent] {
        if old == new { return [] }
        var events: [CollapseEvent] = []
        if old == .interacting { events.append(.endDrag(velocity: new == .decelerating ? 1 : 0)) }
        if old == .decelerating { events.append(.momentumEnd) }
        if old == .animating && new == .idle && m.offset <= scrolledToTopSlop { events.append(.show) }
        if new == .interacting { events.append(.beginDrag(m)) }
        return events
    }

    /// How close to the top (pt) an animated scroll has to settle to count as a scroll to top.
    static let scrolledToTopSlop = 1.0
}
