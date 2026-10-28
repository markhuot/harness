import Foundation

/// A label as clients show it (DESIGN.md "Labels"). The collection comes sorted by `lastUsedAt`,
/// most recently added to a ticket first.
public struct LabelInfo: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var name: String
    /// One of the project color preset ids (`ProjectColors`): every theme draws them alike
    public var color: String
    public var createdAt: Timestamp
    /// When the label was last added to a ticket
    public var lastUsedAt: Timestamp
    /// Tickets carrying it in any status, done included. Drafts don't count.
    public var count: Int

    public var id: String { name }

    public init(name: String, color: String, createdAt: Timestamp, lastUsedAt: Timestamp, count: Int) {
        self.name = name
        self.color = color
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.count = count
    }
}

/// PATCH /labels/:name
public struct UpdateLabelBody: Codable, Sendable, Equatable {
    public var color: String

    public init(color: String) {
        self.color = color
    }
}
