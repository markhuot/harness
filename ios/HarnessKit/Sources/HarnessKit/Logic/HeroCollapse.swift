import Foundation

// When the ticket hero (title, badges, actions) gets out of
// the way. A gesture that scrolls a tab's body forward hides it and one that scrolls back brings it
// back, like Safari's toolbars. The tab strip stays put, so the hero reads as the top of the page
// scrolling off.
//
// Only a gesture (a drag and the momentum after it) toggles it, and at most once per gesture.
//
// The tab body keeps the hero's room at its end (the ticket screen slides the body over the hero
// instead of resizing it), so at the very end the hero comes back, like Safari's toolbars at the
// end of a page, and a hide that would land there doesn't happen: hidden, that room would show as
// a gap above the composer.

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

    /// How close to the end (pt) counts as at the end.
    static let endSlop = 1.0

    /// The offset inside the scrollable range: bounces past either end don't count as scrolling.
    private static func clamped(_ m: ScrollMetrics) -> Double {
        min(max(m.offset, 0), max(0, m.contentHeight - m.viewportHeight))
    }

    /// Scrolled to the end of a body that scrolls at all.
    private static func atEnd(_ m: ScrollMetrics) -> Bool {
        let range = m.contentHeight - m.viewportHeight
        return range > 0 && clamped(m) >= range - endSlop
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
            let y = clamped(m)
            // Any scroll that reaches the end, a gesture's or not (a transcript following new output).
            if s.hidden && atEnd(m) { return Collapse(hidden: false, live: false, anchor: y) }
            guard s.live else { return s }
            if s.hidden {
                if y <= 0 || s.anchor - y >= threshold { return Collapse(hidden: false, live: false, anchor: y) }
                next.anchor = max(s.anchor, y)
            } else {
                // With the hero gone the body must still scroll, or nothing could bring the hero back.
                let room = m.contentHeight - m.viewportHeight - heroHeight
                if y - s.anchor >= threshold && room >= threshold && !atEnd(m) { return Collapse(hidden: true, live: false, anchor: y) }
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
