import Foundation

/// A part of the Settings screen a link can jump to (harness://settings?section=general). The
/// screen scrolls there without animation. Only sections the screen anchors are listed.
public enum SettingsSection: String, Hashable, Sendable, CaseIterable {
    case general
}

/// One request to scroll Settings to a section. `serial` makes a repeat of the same link a new
/// request, so the screen jumps again after the person has scrolled away.
public struct SettingsJump: Equatable, Sendable {
    public let section: SettingsSection
    public let serial: Int
}
