import Foundation

/// A field that can be missing, explicitly `null`, or set: protocol.ts's `field?: T | null`.
///
/// PATCH bodies need all three (`absent` leaves the stored value alone, `null` clears or
/// inherits, `value` sets it), and entities use it for `?: T | null` fields so that decoding and
/// re-encoding reproduces the payload exactly.
///
/// Inside a keyed container (any synthesized or hand-written `Codable` struct), `.absent` omits the
/// key, `.null` writes `null`, and `.value(v)` writes `v`. Decoding a missing key gives `.absent`
/// (this relies on the `KeyedEncodingContainer`/`KeyedDecodingContainer` overloads below, which
/// synthesized conformances pick over the generic ones). Encoded on its own (a single value),
/// `.absent` has nothing to omit and writes `null`.
public enum Patch<Wrapped> {
    /// The key isn't sent.
    case absent
    /// The key is sent as `null`.
    case null
    /// The key is sent with this value.
    case value(Wrapped)

    /// `nil` → `.null`, otherwise `.value`. Use it to send an optional as an explicit value.
    public init(_ optional: Wrapped?) {
        if let optional { self = .value(optional) } else { self = .null }
    }

    /// The value when set; `nil` for both `.absent` and `.null`.
    public var optional: Wrapped? {
        if case let .value(v) = self { return v }
        return nil
    }

    /// True unless `.absent`.
    public var isPresent: Bool {
        if case .absent = self { return false }
        return true
    }

    /// Transforms a set value; `.absent` and `.null` pass through.
    public func map<T>(_ transform: (Wrapped) throws -> T) rethrows -> Patch<T> {
        switch self {
        case .absent: .absent
        case .null: .null
        case let .value(v): .value(try transform(v))
        }
    }
}

extension Patch: Sendable where Wrapped: Sendable {}
extension Patch: Equatable where Wrapped: Equatable {}
extension Patch: Hashable where Wrapped: Hashable {}

extension Patch: Codable where Wrapped: Codable {
    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        self = c.decodeNil() ? .null : .value(try c.decode(Wrapped.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .absent, .null: try c.encodeNil()
        case let .value(v): try c.encode(v)
        }
    }
}

/// A `T | null` field the service always sends: `nil` encodes as an explicit `null` (plain Swift
/// optionals omit the key). A missing key decodes as `nil`, so payloads from older services that
/// leave it out still decode.
@propertyWrapper
public struct Nullable<Wrapped> {
    public var wrappedValue: Wrapped?
    public init(wrappedValue: Wrapped?) { self.wrappedValue = wrappedValue }
}

extension Nullable: Sendable where Wrapped: Sendable {}
extension Nullable: Equatable where Wrapped: Equatable {}
extension Nullable: Hashable where Wrapped: Hashable {}

extension Nullable: Codable where Wrapped: Codable {
    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        wrappedValue = c.decodeNil() ? nil : try c.decode(Wrapped.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        if let wrappedValue { try c.encode(wrappedValue) } else { try c.encodeNil() }
    }
}

extension KeyedEncodingContainer {
    /// Omits `.absent`, writes `null` for `.null`.
    public mutating func encode<W: Encodable>(_ patch: Patch<W>, forKey key: Key) throws {
        switch patch {
        case .absent: return
        case .null: try encodeNil(forKey: key)
        case let .value(v): try encode(v, forKey: key)
        }
    }
}

extension KeyedDecodingContainer {
    /// A missing key is `.absent`; `null` is `.null`.
    public func decode<W: Decodable>(_ type: Patch<W>.Type, forKey key: Key) throws -> Patch<W> {
        guard contains(key) else { return .absent }
        if try decodeNil(forKey: key) { return .null }
        return .value(try decode(W.self, forKey: key))
    }

    /// A missing key or `null` is `nil`.
    public func decode<W: Decodable>(_ type: Nullable<W>.Type, forKey key: Key) throws -> Nullable<W> {
        Nullable(wrappedValue: try decodeIfPresent(W.self, forKey: key))
    }
}

/// A coding key made from any string, for the hand-written discriminated unions.
struct AnyCodingKey: CodingKey, ExpressibleByStringLiteral {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
    init(stringLiteral value: String) { stringValue = value }
}
