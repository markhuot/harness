import Foundation

/// A string union from protocol.ts (`"auto" | "ask" | "read_only"`) as a Swift enum that never
/// fails to decode: a value this build doesn't know becomes `.unknown(raw)` and encodes back as
/// the same string, so a newer service can add values without breaking older apps.
///
/// Conforming enums list their known cases in `allKnown` (the TS declaration order), add
/// `case unknown(String)`, and spell out `rawValue`. Everything else (the non-failable
/// `init(rawValue:)`, Codable as a bare JSON string) comes from this protocol.
///
/// ```swift
/// public enum PermissionMode: OpenEnum {
///     case auto, ask, readOnly
///     case unknown(String)
///     public static let allKnown: [Self] = [.auto, .ask, .readOnly]
///     public var rawValue: String {
///         switch self { case .auto: "auto"; case .ask: "ask"; case .readOnly: "read_only"; case let .unknown(r): r }
///     }
/// }
/// ```
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable, CustomStringConvertible where RawValue == String {
    /// Every value this build knows, in protocol.ts order (the TS `as const` array, where there is one).
    static var allKnown: [Self] { get }
    /// A value this build doesn't know. Satisfied by the enum's `case unknown(String)`.
    static func unknown(_ rawValue: String) -> Self
    /// The wire string.
    var rawValue: String { get }
}

extension OpenEnum {
    /// Never fails: an unrecognized string becomes `.unknown(rawValue)`.
    public init(rawValue: String) {
        self = Self.parse(rawValue)
    }

    /// The known case for `rawValue`, else `.unknown(rawValue)`.
    public static func parse(_ rawValue: String) -> Self {
        allKnown.first { $0.rawValue == rawValue } ?? .unknown(rawValue)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        self = Self.parse(try c.decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    /// False for `.unknown(_)`.
    public var isKnown: Bool { Self.allKnown.contains(self) }

    public var description: String { rawValue }
}
