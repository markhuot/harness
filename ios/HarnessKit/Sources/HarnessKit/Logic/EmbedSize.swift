import Foundation

/// Port of shared/src/state/embeds.ts: an embedded page's height (DESIGN.md "Embedded pages"). The
/// page posts its content height (the service's sizing script); the app sizes the embed to it.
public struct EmbedSize: Equatable, Sendable {
    /// The embed's height before the page reports one, and for a page that never does.
    public static let defaultHeight: Double = 360
    /// The tallest an embed grows; past it the page scrolls inside.
    public static let maxHeight: Double = 5000
    /// Equal growth steps in a row that mean the page is tracking its own frame.
    static let trackingSteps = 4

    public var height: Double = EmbedSize.defaultHeight
    /// Growth of the last step, and how many steps in a row grew by exactly that.
    public var step: Double = 0
    public var streak = 0
    /// Stopped following the page: it grows with its own frame, so it keeps its height and scrolls inside.
    public var locked = false

    public init() {}

    init(height: Double, step: Double, streak: Int, locked: Bool) {
        self.height = height
        self.step = step
        self.streak = streak
        self.locked = locked
    }

    /// The size after the page reports `reported` (`embedSizeAfter`): anything but a positive finite
    /// number is ignored, heights are whole and held to `maxHeight`, and a page that grows by the
    /// same amount `trackingSteps` times in a row stops being followed.
    public func after(_ reported: Double?) -> EmbedSize {
        guard !locked, let reported, reported.isFinite, reported > 0 else { return self }
        let next = min(reported.rounded(.up), Self.maxHeight)
        if next <= height { return EmbedSize(height: next, step: 0, streak: 0, locked: false) }
        let step = next - height
        let streak = step == self.step ? self.streak + 1 : 1
        if streak >= Self.trackingSteps { return EmbedSize(height: height, step: self.step, streak: self.streak, locked: true) }
        return EmbedSize(height: next, step: step, streak: streak, locked: false)
    }
}
