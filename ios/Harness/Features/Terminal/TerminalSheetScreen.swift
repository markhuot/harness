import HarnessKit
import SwiftUI
import UIKit

/// A terminal the service hosts, as a sheet (or a docked card): ghostty-web in a web view
/// (TerminalWebHost) attached to the same shell the Mac shows. The service sizes the shell to the
/// smallest visible client, so this draws at the size it is given, centered, possibly smaller than
/// the sheet. The sheet attaches while it is on screen and the app is in the foreground, and detaches
/// otherwise, so a sleeping or backgrounded phone never holds the shell small.
struct TerminalSheetScreen: View {
    let id: String
    var cardID: Int?

    @Environment(BoardStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @Environment(\.scenePhase) private var scenePhase

    @State private var host = TerminalWebHost()
    @State private var rules = TerminalAttachRules()
    @State private var onScreen = false
    @State private var ctrlArmed = false
    @State private var endedCode: Int?? = .none
    @State private var truncated = false
    /// The page couldn't start (or died): what it said.
    @State private var failure: String?
    @State private var stopListening: (@MainActor () -> Void)?

    private static let accessoryHeight: CGFloat = 44
    /// The bar's whole height: its keys plus the padding under them.
    private static let barHeight: CGFloat = accessoryHeight + 4

    private var info: TerminalInfo? { store.terminals.first { $0.id == id } }
    private var ended: Bool { endedCode != nil || info?.state == .exited || (store.state.ready && info == nil && !store.terminals.isEmpty) }

    var body: some View {
        // The key bar sits below the web view, not over it, so the rows the page counts all show.
        VStack(spacing: 0) {
            ZStack {
                TerminalWebViewRepresentable(host: host)
                    .accessibilityIdentifier("terminal-web")
                if ended || failure != nil { endedBanner }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            accessoryBar.offset(y: -host.keyboardCover)
        }
        .background(c.bg)
        // The keyboard covers the terminal instead of resizing it, so the rows the shell is given never
        // change with it (the page pans to keep the cursor visible, and the bar rides above the keyboard).
        .ignoresSafeArea(.keyboard)
        .navigationTitle(info.map(TerminalList.label) ?? "Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let cardID {
                ToolbarItem(placement: .topBarLeading) {
                    Button { router.closeSheet(id: cardID) } label: { Label("Close", systemImage: "xmark") }
                }
            }
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
        }
        .onAppear { start() }
        .onDisappear { stop() }
        .onChange(of: scenePhase) { _, _ in refreshVisibility() }
        .onChange(of: store.socketGeneration) { _, _ in socketReset() }
        .onChange(of: store.epoch) { _, _ in socketReset() }
        .onChange(of: c.theme.pluginInfo) { _, info in
            host.setBackground(UIColor(c.bg))
            host.send(.theme(FileEditorTheme(info)))
        }
        .task { await store.refreshTerminals() }
    }

    // MARK: Chrome

    private var endedBanner: some View {
        VStack(spacing: 8) {
            Spacer()
            HStack(spacing: 8) {
                Image(systemName: "terminal").foregroundStyle(c.text3)
                Text(endedText).font(.footnote).foregroundStyle(c.text2)
                Spacer(minLength: 8)
                if let cardID { Button("Close") { router.closeSheet(id: cardID) } }
            }
            .padding(10)
            .background(c.bgElev, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(c.border))
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        }
        .accessibilityIdentifier("terminal-ended")
    }

    private var endedText: String {
        if let failure { return "Couldn't start the terminal: \(failure)" }
        if case let .some(.some(code)) = endedCode { return "Process exited (code \(code))" }
        return "This terminal has ended"
    }

    private var moreMenu: some View {
        Menu {
            if let info { Button { UIPasteboard.general.string = info.cwd } label: { Label("Copy folder path", systemImage: "folder") } }
            Button { if let text = UIPasteboard.general.string { host.send(.paste(text)) } } label: { Label("Paste", systemImage: "doc.on.clipboard") }
            Divider()
            Button(role: .destructive) {
                Task { await store.closeTerminal(id) }
            } label: { Label("End terminal", systemImage: "xmark.circle") }
        } label: { Image(systemName: "ellipsis.circle") }
            .accessibilityLabel("More")
    }

    /// Esc, Ctrl, Tab and the arrows a phone keyboard lacks.
    private var accessoryBar: some View {
        HStack(spacing: 4) {
            key("esc", .escape)
            Button { ctrlArmed.toggle(); host.send(.ctrl(ctrlArmed)) } label: {
                Text("ctrl").font(.system(.footnote, design: .monospaced).weight(.medium))
                    .frame(maxWidth: .infinity, minHeight: 32)
                    .background(ctrlArmed ? c.accent.opacity(0.25) : c.bgElev, in: RoundedRectangle(cornerRadius: 7))
                    .foregroundStyle(ctrlArmed ? c.accent : c.text)
            }
            .accessibilityIdentifier("terminal-key-ctrl")
            key("tab", .tab)
            key("←", .left)
            key("↓", .down)
            key("↑", .up)
            key("→", .right)
            key("|", .pipe)
            keyboardToggle
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
        .frame(height: Self.accessoryHeight + 4)
        .frame(maxWidth: .infinity)
        .background(.bar, ignoresSafeAreaEdges: .bottom)
        .onAppear { host.barHeight = Self.barHeight }
    }

    /// Takes the keyboard down while it is up, and brings it back while it is down.
    private var keyboardToggle: some View {
        let up = host.editing
        return Button { if up { host.resignFocus() } else { host.send(.focus) } } label: {
            Image(systemName: up ? "keyboard.chevron.compact.down" : "keyboard")
                .font(.footnote.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 32)
                .background(c.bgElev, in: RoundedRectangle(cornerRadius: 7))
                .foregroundStyle(c.text)
        }
        .accessibilityLabel(up ? "Hide keyboard" : "Show keyboard")
        .accessibilityIdentifier(up ? "terminal-key-dismiss" : "terminal-key-show")
    }

    private func key(_ label: String, _ key: TerminalKey) -> some View {
        Button { host.send(.focus); send(key.sequence) } label: {
            Text(label).font(.system(.footnote, design: .monospaced).weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 32)
                .background(c.bgElev, in: RoundedRectangle(cornerRadius: 7))
                .foregroundStyle(c.text)
        }
        .accessibilityIdentifier("terminal-key-\(label)")
    }

    // MARK: Attaching

    private func start() {
        onScreen = true
        host.setBackground(UIColor(c.bg))
        host.onReady = {
            host.send(.open(id: id, theme: FileEditorTheme(c.theme.pluginInfo), fontSize: 13))
        }
        host.onEvent = { event in handle(event) }
        host.barHeight = Self.barHeight
        stopListening = store.onTerminalMessage { message in
            switch message {
            case let .terminalSnapshot(mid, _, _, _, _, _), let .terminalOutput(mid, _, _), let .terminalExit(mid, _):
                guard mid == id else { return }
                if case let .terminalExit(_, code) = message { endedCode = .some(code) }
                host.send(.message(message))
            default: break
            }
        }
        if host.ready { host.send(.open(id: id, theme: FileEditorTheme(c.theme.pluginInfo), fontSize: 13)) }
        refreshVisibility()
    }

    private func stop() {
        onScreen = false
        refreshVisibility()
        stopListening?()
        stopListening = nil
    }

    private func refreshVisibility() {
        run(rules.visibilityChanged(onScreen && scenePhase == .active))
    }

    private func socketReset() {
        host.send(.reconnecting)
        run(rules.socketReset())
    }

    private func handle(_ event: TerminalEvent) {
        switch event {
        case let .viewport(cols, rows): run(rules.viewportChanged(cols: cols, rows: rows))
        case let .input(data): send(data)
        case .resync: for action in rules.resync() { run(action) }
        case let .exit(code): endedCode = .some(code)
        case let .ctrl(on): ctrlArmed = on
        case .truncated: truncated = true
        case let .error(message): failure = message
        case .ready: failure = nil
        case .title, .bell: break
        }
    }

    private func send(_ data: String) { store.writeTerminal(id, data: data) }

    private func run(_ action: TerminalAttachRules.Action?) {
        guard let action else { return }
        switch action {
        case let .attach(cols, rows): store.attachTerminal(id, deviceId: app.deviceId(), cols: cols, rows: rows)
        case let .resize(cols, rows): store.resizeTerminal(id, cols: cols, rows: rows)
        case .detach: store.detachTerminal(id)
        }
    }
}
