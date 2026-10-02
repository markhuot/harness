import HarnessKit
import SwiftUI

/// Live view of the session's headless Chrome, one browser tab at a time (a strip of tab chips
/// shows once there are two or more; + opens another). Screencast frames
/// (base64 JPEG) are letterboxed into the stage and swapped only once decoded, so a new frame never
/// flashes blank; touches become page mouse/wheel input (HarnessKit BrowserInput); a hidden text
/// field carries the keyboard. The page viewport follows the stage size, sent once the
/// subscription is confirmed and only on change.
struct BrowserTabView: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @State private var model = BrowserTabModel()
    @State private var urlDraft = ""
    @State private var urlSelection: TextSelection?
    @FocusState private var editingUrl: Bool
    @State private var typing = false

    private var sessionId: String { ticket.sessionId }
    private var client: HarnessClient? { store.api }

    private struct Subscription: Hashable {
        let sessionId: String
        let epoch: Int
        let socket: Int
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            tabStrip
            status
            stage
        }
        .background(BrowserKeyField(focused: $typing, onText: model.typed, onKey: model.press)
            .frame(width: 1, height: 1)
            .opacity(0)
            .accessibilityHidden(true))
        .task(id: Subscription(sessionId: sessionId, epoch: store.epoch, socket: store.socketGeneration)) {
            await model.run(sessionId: sessionId, store: store, client: client)
        }
        .onChange(of: model.state?.url, initial: true) { _, url in
            if !editingUrl { urlDraft = url ?? "" }
        }
        .onChange(of: editingUrl) { _, editing in
            if editing {
                // Editing starts with the whole URL selected.
                urlSelection = TextSelection(range: urlDraft.startIndex..<urlDraft.endIndex)
            } else {
                urlDraft = model.state?.url ?? urlDraft
            }
        }
    }

    // MARK: Toolbar

    private var toolbar: some View {
        HStack(spacing: 2) {
            BrowserBarButton(icon: "chevronLeft", label: "Back", disabled: model.empty) { model.command(.back) }
            BrowserBarButton(icon: "chevronRight", label: "Forward", disabled: model.empty) { model.command(.forward) }
            HStack(spacing: 6) {
                Image(icon: "globe").font(.scaled(size: 13)).foregroundStyle(c.text3)
                TextField("", text: $urlDraft, selection: $urlSelection, prompt: Text("Enter a URL…").foregroundStyle(c.text3))
                    .font(.scaled(size: 14, design: .monospaced))
                    .foregroundStyle(c.text)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.URL)
                    .submitLabel(.go)
                    .focused($editingUrl)
                    .onSubmit { Task { await navigate() } }
                    .padding(.vertical, 6)
                    .accessibilityLabel("Address")
                if model.state?.loading == true { Spinner() }
            }
            .padding(.horizontal, 9)
            .background(c.bgSunken, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(c.border, lineWidth: 0.5))
            .padding(.horizontal, 4)
            BrowserBarButton(icon: "refresh", label: "Reload", disabled: model.empty) { model.command(.reload) }
            BrowserBarButton(icon: "edit", label: typing ? "Hide keyboard" : "Type into the page", active: typing, disabled: model.frame == nil) {
                typing.toggle()
            }
            BrowserBarButton(icon: "plus", label: "New tab", disabled: !BrowserTabSelection.supportsTabs(model.state)) {
                model.newTab()
                // Like Safari: a new tab starts in the address bar.
                urlDraft = ""
                editingUrl = true
            }
        }
        .padding(6)
        .background(c.bgElev)
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 0.5) }
    }

    // MARK: Tabs

    /// The open tabs, once there are two or more; the shown one is highlighted and kept in view.
    @ViewBuilder private var tabStrip: some View {
        let tabs = BrowserTabSelection.strip(model.state)
        if !tabs.isEmpty {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(tabs) { tab in
                            BrowserTabChip(
                                tab: tab, current: tab.id == model.selection.shown,
                                select: { model.selectTab(tab.id) }, close: { model.closeTab(tab.id) })
                                .id(tab.id)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                }
                .onChange(of: model.selection.shown, initial: true) { _, id in
                    guard let id else { return }
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id) }
                }
            }
            .background(c.bgElev)
            .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 0.5) }
        }
    }

    private var status: some View {
        HStack(spacing: 6) {
            Circle().fill(model.live ? c.green : c.text3).frame(width: 7, height: 7)
            Text(model.live ? "Live" : "Idle").font(.scaled(size: 12)).foregroundStyle(c.text3)
            if let title = model.state?.title, !title.isEmpty, title != model.state?.url {
                Text("· \(title)").font(.scaled(size: 12.5)).foregroundStyle(c.text2).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
    }

    // MARK: Stage

    private var stage: some View {
        GeometryReader { geo in
            let drawn = model.drawn
            ZStack(alignment: .topLeading) {
                c.bgSunken
                if let frame = model.frame {
                    Image(uiImage: frame.image)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: drawn.w, height: drawn.h)
                        .offset(x: drawn.x, y: drawn.y)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                BrowserTouchSurface(
                    enabled: model.frame != nil,
                    began: { model.touchBegan($0, at: $1) },
                    moved: { model.touchMoved($0, at: $1) },
                    ended: { model.touchEnded($0, at: $1) },
                    cancelled: { model.touchCancelled() })
                    .accessibilityElement()
                    .accessibilityLabel("Browser page. Tap to click, drag to scroll, hold then drag to select.")
                if model.empty {
                    EmptyState(icon: "globe", title: "No browser yet",
                               message: "When the agent opens a page it appears here. You can also enter a URL above.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.frame == nil {
                    VStack(spacing: 8) {
                        Spinner()
                        Text("Waiting for the first frame…").foregroundStyle(c.text3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .clipped()
            .onChange(of: geo.size, initial: true) { _, size in
                model.setStage(CGSize(width: size.width.rounded(), height: size.height.rounded()))
            }
        }
    }

    private func navigate() async {
        let url = Format.normalizeUrl(urlDraft)
        guard !url.isEmpty, let client else { return }
        urlDraft = url
        editingUrl = false
        let id = sessionId
        let tab = model.selection.shown
        if let next = await actions.run(nil, { try await client.browserNavigate(id, url: url, tabId: tab) }) { model.apply(next) }
    }
}

/// One open tab in the strip: spinner while loading, its label (title, host, or "New Tab"), and a
/// close button. Tapping it switches to that tab. A suspended tab (its page closed to save memory)
/// is dimmed until it's opened, which reloads it.
struct BrowserTabChip: View {
    let tab: BrowserTab
    let current: Bool
    let select: () -> Void
    let close: () -> Void
    @Environment(\.palette) private var c

    private var dimmed: Bool { tab.isSuspended && !current }

    var body: some View {
        let label = BrowserTabSelection.label(tab)
        HStack(spacing: 6) {
            if tab.loading { Spinner().controlSize(.mini) }
            Text(label)
                .font(.scaled(size: 12.5, weight: current ? .semibold : .regular))
                .italic(dimmed)
                .foregroundStyle(current ? c.accentText : c.text2)
                .opacity(dimmed ? 0.55 : 1)
                .lineLimit(1)
                .truncationMode(.tail)
            Button {
                haptic(.tap)
                close()
            } label: {
                Image(icon: "x")
                    .font(.scaled(size: 10, weight: .bold))
                    .foregroundStyle(current ? c.accentText : c.text3)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close \(label)")
        }
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .frame(maxWidth: 180)
        .frame(height: 30)
        .background(current ? c.accentSoft : c.bgSunken, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(current ? .clear : c.border, lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .onTapGesture {
            guard !current else { return }
            haptic(.tap)
            select()
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
        .accessibilityValue(dimmed ? "Suspended, reloads when opened" : "")
        .accessibilityAction { select() }
    }
}

/// A toolbar icon button: 34 pt, tap haptic, accent tint when active.
struct BrowserBarButton: View {
    let icon: String
    let label: String
    var active = false
    var disabled = false
    let action: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        Button {
            haptic(.tap)
            action()
        } label: {
            Image(icon: icon)
                .font(.scaled(size: 17, weight: .semibold))
                .foregroundStyle(active ? c.accentText : c.text2)
                .frame(width: 34, height: 34)
                .background(active ? c.accentSoft : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.35 : 1)
        .accessibilityLabel(label)
    }
}
