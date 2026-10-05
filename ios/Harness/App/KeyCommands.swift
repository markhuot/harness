import HarnessKit
import SwiftUI

// The desktop's keyboard shortcuts (app/src/renderer/state/keys.ts) for a hardware keyboard on
// iPad and iPhone, checked on the simulator with AXe key presses. How iOS treats a SwiftUI
// `.keyboardShortcut` decides the shape:
// - It keeps the first registration of a chord. A shortcut that appears later (one switched on
//   when a field takes focus) or a second screen's copy of it (a ticket pushed over another) never
//   fires, and the button keeps the action it was first given. So the window-wide chords are
//   hidden buttons at the window's root from its first frame (WindowShortcuts, from SceneChrome),
//   their actions read state through references when pressed (the Router, AppModel,
//   ShortcutTargets), and Next/Previous Tab reach the ticket screen on top through
//   ShortcutTargets rather than buttons of their own.
// - ⌘↩ on a field that shares its screen (the composer, a spec, an approval's note) is
//   `.onSubmitShortcut`, a key press on the focused field. A sheet's or cover's primary button
//   carries it instead (`.submitShortcut`), as do the Esc Cancel buttons (`.cancelAction`).
// - Not SwiftUI `Commands`: on iPhone their menu commands never fire, iOS answers ⌘, itself (it
//   opens the app's page in the Settings app) before the menu sees it, and placing one in the
//   system's Settings or sidebar group crashed the app at launch. Buttons in the window come
//   before the system's menu in the responder chain, so they win on both.
// - While a sheet is up the window's chords don't fire, as the desktop's don't over a modal; the
//   Projects sheet answers ⌃⌘S itself to close.
// The desktop's other chords have nothing to act on here: no command palette (⌘K, ⌘P), panes
// (⌥⌘ arrows, ⌘W, ⇧⌘↩, ⇧⌘O, ⌘=) or terminals (⌘T), and iPadOS lists the shortcuts itself when
// ⌘ is held (⌘/).

extension KeyboardShortcut {
    /// ⌘↩: send or save what the focused field holds, as on the desktop.
    static let submit = KeyboardShortcut(.return, modifiers: .command)
}

extension View {
    /// ⌘↩ presses this button: the primary action of a sheet or cover, whose fields are all there is.
    func submitShortcut() -> some View {
        keyboardShortcut(KeyboardShortcut.submit)
    }

    /// ⌘↩ runs `action` while this field has focus (nil: the key goes on as usual). For a field that
    /// shares the screen with others (the composer, the Details tab's spec, the approval's note),
    /// so only the one being typed in answers. A button's shortcut can't do that: one that switches
    /// on as its field takes focus never fires.
    func onSubmitShortcut(_ action: (() -> Void)?) -> some View {
        onKeyPress(.return, phases: .down) { press in
            guard let action, press.modifiers == .command else { return .ignored }
            action()
            return .handled
        }
    }

    /// Buttons that are only there for their keyboard shortcuts: not drawn, not read by VoiceOver.
    func hiddenShortcuts(@ViewBuilder _ buttons: () -> some View) -> some View {
        background {
            buttons()
                .opacity(0)
                .accessibilityHidden(true)
        }
    }
}

/// What a window's root shortcuts act on that lives further down: the ticket screen showing, for
/// Next Tab and Previous Tab. Screens register as they appear and leave as they go, so the last one
/// is the one on top (a ticket pushed over another, then popped, hands the keys back).
@MainActor
final class ShortcutTargets {
    private var tabSteppers: [(owner: ObjectIdentifier, step: (Int) -> Void)] = []

    func addTabStepper(_ owner: AnyObject, _ step: @escaping (Int) -> Void) {
        removeTabStepper(owner)
        tabSteppers.append((ObjectIdentifier(owner), step))
    }

    func removeTabStepper(_ owner: AnyObject) {
        tabSteppers.removeAll { $0.owner == ObjectIdentifier(owner) }
    }

    func stepTab(_ delta: Int) { tabSteppers.last?.step(delta) }
}

extension EnvironmentValues {
    /// The window's ShortcutTargets (SceneChrome).
    @Entry var shortcutTargets: ShortcutTargets?
}

/// The window-wide chords, for a main or a ticket window: New Session (⌘N), All Projects (⌘1),
/// Inbox (⌘2), Settings (⌘,), and Next Tab (⇧⌘]) and Previous Tab (⇧⌘[) on the ticket showing.
/// In a ticket window the sections open in a main window (Router.onSectionLink), and New session
/// comes up over the ticket. They're all here, at the root and from the first frame, because iOS
/// keeps the first registration of a chord: one added later, or a second screen's, never fires.
struct WindowShortcuts: View {
    let router: Router
    let targets: ShortcutTargets

    @Environment(AppModel.self) private var app

    var body: some View {
        Button("Next Tab") { targets.stepTab(1) }
            .keyboardShortcut("]", modifiers: [.command, .shift])
        Button("Previous Tab") { targets.stepTab(-1) }
            .keyboardShortcut("[", modifiers: [.command, .shift])
        if app.active != nil {
            Button("New Session") {
                guard let store = app.store else { return }
                router.present(.newSession(projectId: Self.boardProject(store.state, app.prefs), key: nil))
            }
            .keyboardShortcut("n")
            Button("All Projects") { router.select(.allProjects, app: app) }
                .keyboardShortcut("1")
            Button("Inbox") { router.open(.tab(.inbox)) }
                .keyboardShortcut("2")
            Button("Settings") { router.open(.tab(.settings)) }
                .keyboardShortcut(",")
        }
    }

    /// The board's project, as the board's own New session button passes it: nil on All projects
    /// or a group's board.
    static func boardProject(_ state: BoardState, _ prefs: Prefs) -> String? {
        state.boardFilter(prefs.boardProject).flatMap { Paging.scopeGroup($0) == nil ? $0 : nil }
    }
}
