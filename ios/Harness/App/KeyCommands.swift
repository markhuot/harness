import HarnessKit
import SwiftUI

// The desktop's keyboard shortcuts (app/src/renderer/state/keys.ts) for a hardware keyboard on
// iPad and iPhone. The window-wide ⌘ chords are menu commands (HarnessCommands): iPadOS lists them
// in its menu bar and in the overlay holding ⌘ shows, and they act on the key window through its
// Router (`focusedSceneValue(\.windowRouter)`). A screen's own chords sit on its buttons: ⌘↩ sends
// or saves what its field holds (`.submitShortcut`), ⇧⌘] and ⇧⌘[ step through a ticket's tabs.
// The desktop's other chords have nothing to act on here: no command palette (⌘K, ⌘P), panes
// (⌥⌘ arrows, ⌘W, ⇧⌘↩, ⇧⌘O, ⌘=) or terminals (⌘T), and iPadOS lists the shortcuts itself (⌘/).

extension FocusedValues {
    /// The key window's Router: a main window's or a ticket window's.
    @Entry var windowRouter: Router?
    /// Shows or hides the key main window's Projects sidebar (MainTabs).
    @Entry var toggleSidebar: SidebarToggle?
}

/// Toggle Sidebar for one main window: the split view's column at regular width, the Projects
/// sheet at compact width.
struct SidebarToggle {
    let shown: Bool
    let toggle: @MainActor () -> Void
}

extension KeyboardShortcut {
    /// ⌘↩: send or save what the focused field holds, as on the desktop.
    static let submit = KeyboardShortcut(.return, modifiers: .command)
}

extension View {
    /// ⌘↩ presses this button while `active`: a field's send or save button, active while that field
    /// has focus, so two fields on screen at once (the composer and the Details tab's spec, say)
    /// never both answer it.
    func submitShortcut(_ active: Bool = true) -> some View {
        keyboardShortcut(active ? KeyboardShortcut.submit : nil)
    }
}

/// The app's menu commands, the desktop's menu-bar chords: New Session (⌘N), Settings (⌘,), Toggle
/// Sidebar (⌃⌘S), and Go → All Projects (⌘1) and Inbox (⌘2). Each acts on the key window; in a
/// ticket window the sections open in a main window (Router.onSectionLink).
/// (`SwiftUI.Commands`: HarnessKit's `Commands` is the slash-command catalog.)
@MainActor
struct HarnessCommands: SwiftUI.Commands {
    let app: AppModel

    @FocusedValue(\.windowRouter) private var router
    @FocusedValue(\.toggleSidebar) private var sidebar

    var body: some SwiftUI.Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Session…") { newSession() }
                .keyboardShortcut("n")
                .disabled(router == nil || app.store == nil)
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { router?.open(.tab(.settings)) }
                .keyboardShortcut(",")
                .disabled(router == nil || app.active == nil)
        }
        CommandGroup(before: .sidebar) {
            Button(sidebar?.shown == false ? "Show Sidebar" : "Hide Sidebar") { sidebar?.toggle() }
                .keyboardShortcut("s", modifiers: [.control, .command])
                .disabled(sidebar == nil)
        }
        CommandMenu("Go") {
            Button("All Projects") { router?.select(.allProjects, app: app) }
                .keyboardShortcut("1")
                .disabled(router == nil || app.active == nil)
            Button("Inbox") { router?.open(.tab(.inbox)) }
                .keyboardShortcut("2")
                .disabled(router == nil || app.active == nil)
        }
    }

    /// New session for the board's project, as the board's own button opens it (none on All
    /// projects or a group's board).
    private func newSession() {
        guard let router, let store = app.store else { return }
        let filter = store.state.boardFilter(app.prefs.boardProject)
        let project = filter.flatMap { Paging.scopeGroup($0) == nil ? $0 : nil }
        router.present(.newSession(projectId: project, key: nil))
    }
}
