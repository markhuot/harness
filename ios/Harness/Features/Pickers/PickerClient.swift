import HarnessKit
import SwiftUI

/// The requests the pickers make beyond BoardClient: model lists, branch search and the @-mention /
/// slash-command lookups. HarnessClient conforms; `store.pickerClient` is nil for a store built on
/// some other client (tests), and the pickers then show empty lists.
protocol PickerClient: Sendable {
    func listModels(_ driverId: String, refresh: Bool) async throws -> DriverModels
    func projectBranches(_ id: String, q: String?, limit: Int?) async throws -> [BranchInfo]
    func projectFiles(_ id: String, q: String, _ options: FileSearchOptions) async throws -> [FileMatch]
    func projectCommands(_ id: String, q: String, driver: String?, limit: Int?) async throws -> [CommandMatch]
    func ticketFiles(_ key: String, q: String, _ options: FileSearchOptions) async throws -> [FileMatch]
    func ticketCommands(_ key: String, q: String, limit: Int?) async throws -> [CommandMatch]
}

extension HarnessClient: PickerClient {}

/// The shared per-driver model list cache, one per store (`modelCacheFor(client)` in RN), so every
/// model select on screen shares one fetch per driver.
@MainActor
private enum PickerModelCaches {
    static var store: ObjectIdentifier?
    static var cache: ModelListCache?
}

extension BoardStore {
    var pickerClient: (any PickerClient)? { client as? any PickerClient }

    /// The model list cache for this store (rebuilt when the active store changes).
    var sharedModelCache: ModelListCache {
        let id = ObjectIdentifier(self)
        if PickerModelCaches.store == id, let cache = PickerModelCaches.cache { return cache }
        let picker = pickerClient
        let cache = ModelListCache { driver, refresh in
            guard let picker else { throw HarnessAPIError(status: 0, message: "No connection", data: nil) }
            return try await picker.listModels(driver, refresh: refresh)
        }
        PickerModelCaches.store = id
        PickerModelCaches.cache = cache
        return cache
    }
}

/// `e instanceof Error ? e.message : String(e)` for the pickers' inline errors.
func pickerErrorMessage(_ error: any Error) -> String {
    if let e = error as? HarnessAPIError { return e.message }
    if let e = error as? LocalizedError, let d = e.errorDescription { return d }
    return error.localizedDescription
}
