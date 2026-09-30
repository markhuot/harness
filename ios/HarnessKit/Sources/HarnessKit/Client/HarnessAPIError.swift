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
}
