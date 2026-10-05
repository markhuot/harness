import HarnessKit
import SwiftUI

// Route → screen. This is the only place that maps navigation values to feature slots
// (ARCHITECTURE.md § Feature slots): a feature ticket replaces its slot's body, not these.

/// A pushed screen.
struct RouteScreen: View {
    let route: Route
    @Environment(\.palette) private var c

    var body: some View {
        Group {
            switch route {
            case let .ticket(key, tab): TicketDetailScreen(key: key, initialTab: tab)
            case let .triage(id): TriageScreen(sessionId: id)
            case let .file(params): FileViewerScreen(params: params)
            case let .project(id): ProjectSettingsScreen(projectId: id)
            case let .driver(id): DriverSettingsScreen(driverId: id)
            case .prompts: PromptsScreen()
            case .extensions: ExtensionSettingsScreen()
            case let .prompt(id): PromptDetailScreen(id: id)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.bg)
    }
}

/// A sheet's content in its own NavigationStack. Every sheet but Projects gets a Cancel (✕)
/// button, which sim-check's tapHeaderCancel looks for; Projects closes by its grabber, and New
/// session draws its own (it asks before dropping a draft).
struct SheetHost: View {
    let sheet: SheetRoute
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(c.bg)
                .toolbar {
                    if !isProjects && !ownsCancel {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel", systemImage: "xmark") { router.sheet = nil }
                        }
                    }
                }
        }
        .presentationDetents(isProjects ? [.fraction(0.6), .large] : [.large])
        .presentationDragIndicator(isProjects ? .visible : .automatic)
        .toastOverlay()
    }

    private var isProjects: Bool {
        if case .projects = sheet { return true }
        return false
    }

    /// New session draws its own Cancel (✕), which asks before dropping a draft.
    private var ownsCancel: Bool {
        if case .newSession = sheet { return true }
        return false
    }

    @ViewBuilder private var content: some View {
        switch sheet {
        case .projects: RequireStore { ProjectsSheet() }
        case let .newSession(projectId, key): RequireStore { NewSessionScreen(projectId: projectId, key: key) }
        case let .watcher(id): RequireStore { WatcherFormScreen(id: id) }
        case .connect: ConnectScreen()
        case let .pair(url, token): PairScreen(url: url, token: token)
        }
    }
}

/// A full-screen cover's content.
struct CoverHost: View {
    let cover: CoverRoute

    var body: some View {
        switch cover {
        case .scan: ScanScreen()
        }
    }
}

/// Routes that need a connection: a spinner until the saved server
/// has loaded (a cold start through a deep link lands here first), Connect without one, and the
/// screen with the store injected once there is one.
struct RequireStore<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(AppModel.self) private var app

    var body: some View {
        if app.loaded && app.active == nil {
            ConnectScreen()
        } else if app.loaded, let store = app.store {
            content.environment(store)
        } else {
            LoadingScreen()
        }
    }
}
