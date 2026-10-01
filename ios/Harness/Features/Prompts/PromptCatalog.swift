import HarnessKit
import SwiftUI

/// Settings → Prompts intro (Prompts.tsx PROMPTS_INTRO).
let promptsIntro = "The instructions Harness gives agents. A built-in prompt picks up improvements with each app update; a customized one stays as you wrote it until you reset it."

/// The prompt catalog (Prompts.tsx usePrompts): GET /prompts, loaded again on reconnect and
/// whenever settings change on any client (`settings.updated`).
@MainActor
@Observable
final class PromptCatalog {
    private(set) var prompts: [PromptEntry]?
    private(set) var error: String?

    @ObservationIgnored private var unsubscribe: (@MainActor () -> Void)?
    @ObservationIgnored private weak var store: BoardStore?
    @ObservationIgnored private var epoch = -1

    /// Load now, and follow settings changes until `stop()`. Calling it again with the same store
    /// and epoch does nothing; a new epoch (reconnect) loads again.
    func start(_ store: BoardStore) {
        if self.store !== store {
            unsubscribe?()
            self.store = store
            unsubscribe = store.onEvent { [weak self] e in
                if case .settingsUpdated = e { Task { await self?.load() } }
            }
        }
        guard epoch != store.epoch else { return }
        epoch = store.epoch
        Task { await load() }
    }

    func stop() {
        unsubscribe?()
        unsubscribe = nil
        store = nil
        epoch = -1
    }

    func load() async {
        guard let api = store?.settingsAPI else { return }
        do {
            prompts = try await api.listPrompts()
            error = nil
        } catch {
            self.error = Prompts.promptsLoadError(error)
        }
    }
}

extension View {
    /// Keeps `catalog` loaded while the view is on screen (and on every reconnect).
    func loadingPrompts(_ catalog: PromptCatalog) -> some View {
        modifier(PromptCatalogLoader(catalog: catalog))
    }
}

private struct PromptCatalogLoader: ViewModifier {
    let catalog: PromptCatalog
    @Environment(BoardStore.self) private var store

    func body(content: Content) -> some View {
        content
            .task(id: store.epoch) { catalog.start(store) }
            .onDisappear { catalog.stop() }
    }
}

/// Built-in / Customized / Broken (Prompts.tsx PromptBadge).
struct PromptBadge: View {
    let entry: PromptEntry

    var body: some View {
        let state = Prompts.promptState(entry)
        switch state {
        case .broken: Badge(state.label, tone: .red, icon: "alert")
        case .customized: Badge(state.label, tone: .accent)
        default: Badge(state.label)
        }
    }
}

/// A spinner while the catalog loads, or why it couldn't.
struct PromptsLoading: View {
    let error: String?
    @Environment(\.palette) private var c

    var body: some View {
        Group {
            if let error {
                EmptyState(icon: "alert", title: "Couldn't load prompts", message: error)
            } else {
                Spinner().padding(40).frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.bg)
    }
}
