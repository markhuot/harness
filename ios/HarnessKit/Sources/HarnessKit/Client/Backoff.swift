import Foundation

/// The socket's reconnect delay: 250 ms, doubling after each failed or dropped connection up to
/// 5 s, back to 250 ms once a connection opens (HarnessSocket in shared/src/client.ts).
public struct ReconnectBackoff: Sendable, Equatable {
    public static let initial: Duration = .milliseconds(250)
    public static let cap: Duration = .seconds(5)

    public private(set) var current: Duration = ReconnectBackoff.initial

    public init() {}

    /// The delay to wait now; the next call returns double (capped).
    public mutating func next() -> Duration {
        let delay = current
        current = min(current * 2, Self.cap)
        return delay
    }

    public mutating func reset() {
        current = Self.initial
    }
}
