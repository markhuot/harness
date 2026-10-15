import Foundation

// ---------------------------------------------------------------------------
// Terminals: shells the service hosts (shared/src/protocol.ts TerminalInfo)
// ---------------------------------------------------------------------------

public enum TerminalState: String, Codable, Sendable, Equatable {
    case running, exited
}

/// A shell the service hosts. Clients attach over the WebSocket (`terminal.attach`); the list is
/// GET /terminals.
public struct TerminalInfo: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    /// Where the shell is now (OSC 7, else polled).
    public var cwd: String
    /// The title the program set (OSC 0/2); "" until one does.
    public var title: String
    /// The foreground program's name ("zsh" at the prompt).
    public var process: String
    /// The project it was created in; nil = All projects.
    @Nullable public var projectId: String?
    public var state: TerminalState
    @Nullable public var exitCode: Int?
    public var createdAt: Timestamp
    /// Device id of the client that created it ("" when unknown).
    public var createdBy: String
    public var cols: Int
    public var rows: Int

    public init(
        id: String, cwd: String, title: String = "", process: String = "", projectId: String? = nil, state: TerminalState = .running,
        exitCode: Int? = nil, createdAt: Timestamp = 0, createdBy: String = "", cols: Int = 80, rows: Int = 24
    ) {
        self.id = id
        self.cwd = cwd
        self.title = title
        self.process = process
        self.projectId = projectId
        self.state = state
        self.exitCode = exitCode
        self.createdAt = createdAt
        self.createdBy = createdBy
        self.cols = cols
        self.rows = rows
    }
}

/// POST /terminals.
public struct CreateTerminalBody: Codable, Sendable, Equatable {
    public var cwd: String?
    /// The project it is created in; `.null` = All projects.
    public var projectId: Patch<String>
    public var deviceId: String?
    public var cols: Int?
    public var rows: Int?
    /// Ask the connected Mac(s) to open a pane for it.
    public var openOnMac: Bool?

    public init(cwd: String? = nil, projectId: Patch<String> = .absent, deviceId: String? = nil, cols: Int? = nil, rows: Int? = nil, openOnMac: Bool? = nil) {
        self.cwd = cwd
        self.projectId = projectId
        self.deviceId = deviceId
        self.cols = cols
        self.rows = rows
        self.openOnMac = openOnMac
    }
}
