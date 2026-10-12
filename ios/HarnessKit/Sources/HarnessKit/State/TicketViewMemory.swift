import Foundation

/// What an iPhone ticket sheet remembers about a ticket's screen after the sheet is dismissed and
/// the view torn down, so reopening it looks the way it was left: the scroll offset of each tab (keyed "<ticket>/<tab>"), and
/// whether the composer had the keyboard. Composer drafts aren't here: the board store keeps those by
/// ticket (`BoardStore.messageDraft(for:)`).
///
/// A dismissal blurs the composer on its way out, which looks the same as the person tapping away
/// from it. A blur within `dismissalWindow` of the composer leaving the screen is the dismissal's,
/// and keeps the focus; any other blur clears it. The decision waits for `wasFocused`, since the blur
/// and the disappearance arrive in either order.
public final class TicketViewMemory {
    public static let dismissalWindow: TimeInterval = 0.5

    private var offsets: [String: Double] = [:]
    private var focused: [String: Bool] = [:]
    private var blurredAt: [String: TimeInterval] = [:]
    private var disappearedAt: [String: TimeInterval] = [:]

    public init() {}

    // MARK: Scroll

    public func setOffset(_ y: Double, for key: String) { offsets[key] = y }
    public func offset(for key: String) -> Double? { offsets[key] }

    // MARK: Composer focus

    public func focusChanged(_ now: Bool, key: String, at time: TimeInterval) {
        if now {
            focused[key] = true
            blurredAt[key] = nil
        } else {
            blurredAt[key] = time
        }
    }

    public func composerDisappeared(key: String, at time: TimeInterval) { disappearedAt[key] = time }

    /// Whether the composer had the keyboard when the ticket was last on screen.
    public func wasFocused(key: String) -> Bool {
        if let blur = blurredAt[key] {
            let dismissal = disappearedAt[key].map { abs($0 - blur) <= Self.dismissalWindow } ?? false
            if !dismissal { focused[key] = false }
            blurredAt[key] = nil
        }
        return focused[key] ?? false
    }

    /// `wasFocused`, once: the restore belongs to the sheet's first appearance after a dismissal, so
    /// a later one (going Back from a pushed child ticket, a sheet mounted behind the top one)
    /// doesn't raise the keyboard again.
    public func consumeFocus(key: String) -> Bool {
        let was = wasFocused(key: key)
        focused[key] = nil
        return was
    }

    /// The ticket's sheet closed for good: nothing to restore.
    public func forget(key: String) {
        // Scroll offsets are kept per tab, "<ticket>/<tab>".
        offsets = offsets.filter { $0.key != key && !$0.key.hasPrefix("\(key)/") }
        focused[key] = nil
        blurredAt[key] = nil
        disappearedAt[key] = nil
    }
}
