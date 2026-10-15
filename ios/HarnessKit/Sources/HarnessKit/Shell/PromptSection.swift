import Foundation

/// A part of a prompt's screen a link can open scrolled to (harness://prompt/<id>?section=actions).
/// The screen jumps there without animation. Only parts the screen anchors are listed. Unlike
/// `SettingsSection` this travels in the route: a prompt is a pushed screen, so a link to a
/// section is a fresh screen already there, with no state on the router.
public enum PromptSection: String, Hashable, Sendable, Codable, CaseIterable {
    /// The Customize / Reset to built-in buttons, above the text.
    case actions
}
