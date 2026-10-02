import Foundation

// RN's `e instanceof Error ? e.message : String(e)`, the message a failed request shows. Swift has
// two reasonable stand-ins for the last branch, and both are in use, so both live here:
//
// - `errorMessage` describes any other error with `String(describing:)`, so a test fake's
//   CustomStringConvertible text ("offline") comes through as is. The board's loaders and the
//   model lists use it.
// - `localizedErrorMessage` uses `localizedDescription`, so a transport failure (URLError) reads
//   "The Internet connection appears to be offline." instead of an NSError dump. Screens that
//   toast or show the error inline use it.
//
// HarnessAPIError (the service's `{ error }`) is a LocalizedError whose description is its
// message, so both give the service's message for it.

/// The service's message for a HarnessAPIError, a LocalizedError's description, else
/// `String(describing:)`.
public func errorMessage(_ error: any Error) -> String {
    if let e = error as? HarnessAPIError { return e.message }
    if let e = error as? LocalizedError, let d = e.errorDescription { return d }
    return String(describing: error)
}

/// The service's message for a HarnessAPIError, else `localizedDescription` (a LocalizedError's
/// description when it has one).
public func localizedErrorMessage(_ error: any Error) -> String {
    if let e = error as? HarnessAPIError { return e.message }
    return error.localizedDescription
}
