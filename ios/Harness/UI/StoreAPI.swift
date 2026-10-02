import HarnessKit
import SwiftUI

extension BoardStore {
    /// The store's client as the full HarnessClient, for the calls that aren't on BoardClient
    /// (settings, network, prompts, watchers, projects, browser and plugin tabs, attachments). nil
    /// only in tests and previews that run the store on a stub client.
    var api: HarnessClient? { client as? HarnessClient }
}

/// The latest render's values, for callbacks SwiftUI may keep from an earlier render: a TextField's
/// `onSubmit` (and the focus-change handlers next to it) can fire with closures that captured an
/// older ticket, so they read it from here. Set during body; not observed.
final class PickerLatest<Value> {
    private(set) var value: Value?
    func set(_ v: Value) { value = v }
}

extension String {
    /// nil for "".
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
