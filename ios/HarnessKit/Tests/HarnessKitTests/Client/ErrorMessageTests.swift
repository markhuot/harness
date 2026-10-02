import Foundation
import Testing
@testable import HarnessKit

private struct Described: Error, CustomStringConvertible {
    var description: String { "offline" }
}

private struct Localized: LocalizedError {
    var errorDescription: String? { "Disk full" }
}

/// A LocalizedError without a description falls through to the last branch.
private struct Undescribed: LocalizedError {}

@Suite("error messages")
struct ErrorMessageTests {
    @Test("the service's message wins for a HarnessAPIError")
    func apiError() {
        let e = HarnessAPIError(status: 409, message: "G-1 has no workdir yet")
        #expect(errorMessage(e) == "G-1 has no workdir yet")
        #expect(localizedErrorMessage(e) == "G-1 has no workdir yet")
        #expect(FileLoadError(e) == FileLoadError(status: 409, message: "G-1 has no workdir yet"))
    }

    @Test("a LocalizedError shows its description in both")
    func localized() {
        #expect(errorMessage(Localized()) == "Disk full")
        #expect(localizedErrorMessage(Localized()) == "Disk full")
    }

    @Test("other errors: errorMessage describes them, localizedErrorMessage localizes them")
    func fallbacks() {
        #expect(errorMessage(Described()) == "offline")
        #expect(localizedErrorMessage(Described()) != "offline")

        let offline = URLError(.notConnectedToInternet)
        #expect(localizedErrorMessage(offline) == offline.localizedDescription)
        #expect(FileLoadError(offline) == FileLoadError(status: nil, message: offline.localizedDescription))
    }

    @Test("a LocalizedError with no description falls through")
    func undescribed() {
        #expect(errorMessage(Undescribed()) == String(describing: Undescribed()))
        #expect(localizedErrorMessage(Undescribed()) == Undescribed().localizedDescription)
    }
}
