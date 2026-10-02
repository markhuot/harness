import Foundation

/// A non-2xx response from the service: `{ error, data? }`. Port of HarnessApiError in
/// shared/src/client.ts. `data` is kept raw so callers can decode it (a 404 from getTicket
/// carries RemoteKeyMatches).
public struct HarnessAPIError: Error, Sendable, Equatable, LocalizedError {
    public var status: Int
    public var message: String
    public var data: JSONValue?

    public init(status: Int, message: String, data: JSONValue? = nil) {
        self.status = status
        self.message = message
        self.data = data
    }

    public var errorDescription: String? { message }

    /// The SpecConflict of a PATCH refused because the spec moved on (409), else nil. Port of
    /// specConflict() in shared/src/client.ts.
    public var specConflict: SpecConflict? {
        guard status == 409, case let .object(o)? = data, case let .number(rev)? = o["currentRevision"],
              case let .string(spec)? = o["spec"] else { return nil }
        return SpecConflict(currentRevision: Int(rev), spec: spec)
    }

    /// `specConflict` of any error that is a HarnessAPIError.
    public static func specConflict(_ error: any Error) -> SpecConflict? {
        (error as? HarnessAPIError)?.specConflict
    }
}
