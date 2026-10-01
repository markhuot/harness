import Foundation

// Port of shared/src/permissions.ts: permission-mode resolution (DESIGN.md "Permissions") and the
// labels the mode pickers show.

public enum Permissions {
    /// Where an effective permission mode came from.
    public enum Source: String, Codable, Sendable, Equatable {
        case ticket, project, settings
    }

    public struct ResolvedMode: Codable, Sendable, Equatable {
        public var mode: PermissionMode
        public var source: Source
        public init(mode: PermissionMode, source: Source) {
            self.mode = mode
            self.source = source
        }
    }

    public struct Label: Codable, Sendable, Equatable {
        public var label: String
        public var description: String
        public init(label: String, description: String) {
            self.label = label
            self.description = description
        }
    }

    /// Resolve the effective mode: ticket override → project override → the global setting. nil
    /// inherits, and so does an empty string (JS truthiness); an unknown mode is passed through.
    public static func resolvePermissionMode(ticket: PermissionMode?, project: PermissionMode?, settings: PermissionMode) -> ResolvedMode {
        if let m = ticket, !m.rawValue.isEmpty { return ResolvedMode(mode: m, source: .ticket) }
        if let m = project, !m.rawValue.isEmpty { return ResolvedMode(mode: m, source: .project) }
        return ResolvedMode(mode: settings, source: .settings)
    }

    /// `resolvePermissionMode` for protocol entities. `settings` is `Settings.permissionMode` or
    /// `PublicSettings.permissionMode`.
    public static func resolvePermissionMode(ticket: Ticket?, project: Project?, settings: PermissionMode) -> ResolvedMode {
        resolvePermissionMode(ticket: ticket?.permissionMode, project: project?.permissionMode, settings: settings)
    }

    /// PERMISSION_MODE_LABELS.
    public static let labels: [PermissionMode: Label] = [
        .auto: Label(label: "Auto", description: "A classifier approves routine actions and asks you about risky ones."),
        .ask: Label(label: "Ask", description: "Edits inside the working directory run; everything else asks you first."),
        .readOnly: Label(label: "Read only", description: "The agent can read and run read-only commands, but can't change anything."),
    ]

    /// The label for a mode; nil for a mode this build doesn't know.
    public static func label(for mode: PermissionMode) -> Label? {
        labels[mode]
    }
}
