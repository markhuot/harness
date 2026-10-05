import Foundation

// Port of shared/src/state/extensions.ts: what Settings → Extensions and the browser's extensions
// menu say about each extension of the service's browser.

public enum Extensions {
    public enum Tone: String, Codable, Sendable { case normal, error }

    public struct Note: Codable, Sendable, Equatable {
        /// A short label beside the name, when its status needs one.
        public var badge: String?
        /// A line under the name.
        public var text: String?
        public var tone: Tone

        public init(badge: String? = nil, text: String? = nil, tone: Tone) {
            self.badge = badge
            self.text = text
            self.tone = tone
        }
    }

    public static func note(_ ext: BrowserExtension) -> Note {
        if ext.source == .chrome {
            return Note(badge: ext.byPolicy == true ? "Installed by your organization" : ext.enabled ? nil : "Off", text: ext.description, tone: .normal)
        }
        switch ext.status {
        case .loaded:
            return Note(text: ext.source == .webstore ? ext.description : nil, tone: .normal)
        case .pending:
            return Note(badge: "Waiting", text: ext.source == .webstore ? "Installs the next time the browser starts." : "Loads the next time the browser starts.", tone: .normal)
        case .off:
            return Note(badge: "Off", tone: .normal)
        case .blocked:
            return Note(badge: "Blocked", text: ext.error ?? "Your organization's Chrome policy doesn't allow it.", tone: .error)
        case .error:
            return Note(badge: "Error", text: ext.error ?? "Chrome couldn't install or load it.", tone: .error)
        case .unknown:
            // A status a newer service sends: show its error, if any, without a label.
            return Note(text: ext.error, tone: ext.error == nil ? .normal : .error)
        }
    }

    /// How many extensions wait for a running browser to restart (one that isn't running picks them up when it next starts).
    public static func waiting(_ list: BrowserExtensionList) -> Int {
        list.running ? list.extensions.filter { $0.status == .pending }.count : 0
    }

    /// The extensions whose toolbar button or options page can open now, by name: what the browser's extensions menu lists.
    /// TS sorts with `localeCompare`; a case-insensitive compare matches it for extension names.
    public static func runnable(_ list: BrowserExtensionList) -> [BrowserExtension] {
        list.extensions
            .filter { $0.status == .loaded && ($0.hasAction || $0.optionsUrl != nil) }
            .sorted { $0.name.compare($1.name, options: [.caseInsensitive], locale: Locale(identifier: "en")) == .orderedAscending }
    }
}
