import HarnessKit
import SwiftUI

/// Live view of the session's headless Chrome, one browser tab at a time (a strip of tab chips that
/// scrolls sideways, with + pinned at its right end to open another). Screencast frames
/// (base64 JPEG) are letterboxed into the stage and swapped only once decoded, so a new frame never
/// flashes blank; touches become page mouse/wheel input (HarnessKit BrowserInput); a hidden text
/// field carries the keyboard.
///
/// Under the address bar, behind the toolbar's Size button (open or closed is remembered; the
/// button shows when the service has per-tab sizes), the tab's size: Desktop | Mobile
/// (each resets to its preset size and reloads), Responsive (the tab follows this stage, sent once
/// the subscription is confirmed and only on change; lit dimmer when another window drives it) and
/// W × H. Pinching the stage zooms the drawn frame 1–4× (two fingers pan it, a two-finger double
/// tap resets it) without the page seeing it; one finger still drives the page through the zoom.
///
/// Each view is its own viewer on the socket (BrowserTabModel.viewer), so a pinned window (iPad)
/// showing one browser tab (`pinnedTab`: no chip strip, no New tab) streams alongside this one. A
/// chip drags out into such a window; while it's torn off, selecting it here shows Return to this
/// window over the stage.
///
/// Annotate (in the toolbar) takes a screenshot of the shown tab (GET /browser/:sessionId/screenshot)
/// and opens it in the annotator.
struct BrowserTabView: View {
    let ticket: Ticket
    var pinnedTab: Int?

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var c
    @State private var model: BrowserTabModel
    @Environment(\.openAnnotator) private var openAnnotator
    @Environment(\.annotationSink) private var sink
    @State private var capturing = false
    @State private var urlDraft = ""
    @State private var urlSelection: TextSelection?
    @FocusState private var editingUrl: Bool
    @State private var typing = false
    @State private var widthDraft = ""
    @State private var heightDraft = ""
    @FocusState private var sizeField: SizeField?
    /// Done applied the drafts, so losing focus doesn't put the old size back.
    @State private var sizeApplied = false
    /// The size row is open (remembered across launches; starts closed).
    @AppStorage("browserSizeRowOpen") private var sizeRowOpen = false

    private enum SizeField: Hashable { case width, height }

    init(ticket: Ticket, pinnedTab: Int? = nil) {
        self.ticket = ticket
        self.pinnedTab = pinnedTab
        _model = State(initialValue: BrowserTabModel(pinnedTab: pinnedTab))
    }

    private var sessionId: String { ticket.sessionId }

    /// The pinned tab closed (or the service moved this view off it).
    private var pinnedGone: Bool {
        guard let pinnedTab, let state = model.state else { return false }
        if let tabs = state.tabs { return !tabs.contains { $0.id == pinnedTab } }
        return false
    }
    private var client: HarnessClient? { store.api }

    private struct Subscription: Hashable {
        let sessionId: String
        let epoch: Int
        let socket: Int
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            if sizeRowOpen, let size = model.state?.size { sizeRow(size) }
            tabStrip
            if let title = shownTitle { status(title) }
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
        // The fields follow the tab's size, but never over an edit in progress.
        .onChange(of: model.state?.size, initial: true) { _, size in
            if sizeField == nil, let size { showSize(size) }
        }
        .onChange(of: sizeField) { _, field in
            guard field == nil else { return }
            if sizeApplied {
                sizeApplied = false
            } else if let size = model.state?.size {
                showSize(size)
            }
        }
        .toolbar {
            if sizeField != nil {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { applySize() }.fontWeight(.semibold)
                }
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
            BrowserBarButton(icon: "", systemImage: typing ? "keyboard.chevron.compact.down" : "keyboard", label: typing ? "Hide keyboard" : "Type into the page", active: typing, disabled: model.frame == nil) {
                typing.toggle()
            }
            if model.state?.size != nil {
                BrowserBarButton(icon: "", systemImage: "aspectratio", label: sizeRowOpen ? "Hide size" : "Size", active: sizeRowOpen) {
                    sizeRowOpen.toggle()
                }
            }
            BrowserBarButton(icon: "", systemImage: "pencil.and.scribble", label: "Annotate", busy: capturing,
                             disabled: model.frame == nil || capturing || openAnnotator == nil || sink == nil) {
                annotate()
            }
        }
        .padding(6)
        .background(c.bgElev)
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 0.5) }
    }

    // MARK: Size

    private func sizeRow(_ size: BrowserSize) -> some View {
        let owner = model.state?.ownsSize == true
        let following = size.responsive && !owner
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                BrowserDeviceControl(device: size.device) { model.setDevice($0) }
                BrowserResponsiveButton(lit: owner, following: following) { model.toggleResponsive() }
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    sizeTextField("W", text: $widthDraft, field: .width, label: "Width")
                    Text("×").font(.scaled(size: 12.5)).foregroundStyle(c.text3)
                    sizeTextField("H", text: $heightDraft, field: .height, label: "Height")
                }
            }
            if following {
                Text("Following another window")
                    .font(.scaled(size: 11.5))
                    .foregroundStyle(c.text3)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(c.bgElev)
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 0.5) }
    }

    private func sizeTextField(_ prompt: String, text: Binding<String>, field: SizeField, label: String) -> some View {
        TextField("", text: text, prompt: Text(prompt).foregroundStyle(c.text3))
            .font(.scaled(size: 12.5, design: .monospaced))
            .foregroundStyle(c.text)
            .multilineTextAlignment(.center)
            .keyboardType(.numberPad)
            .submitLabel(.done)
            .focused($sizeField, equals: field)
            .onSubmit { applySize() }
            .frame(width: 50)
            .padding(.vertical, 5)
            .background(c.bgSunken, in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(sizeField == field ? c.accent : c.border, lineWidth: sizeField == field ? 1 : 0.5))
            .accessibilityLabel(label)
    }

    private func showSize(_ size: BrowserSize) {
        widthDraft = String(size.width)
        heightDraft = String(size.height)
    }

    /// Done (or Return on a hardware keyboard): the tab at the typed size, held to 100–4096,
    /// keeping its mode. Something that isn't a number puts the tab's size back.
    private func applySize() {
        guard let size = model.state?.size else { return }
        if let w = BrowserSize.clampSide(widthDraft), let h = BrowserSize.clampSide(heightDraft) {
            widthDraft = String(w)
            heightDraft = String(h)
            if w != size.width || h != size.height || size.responsive { model.setSize(width: w, height: h) }
        } else {
            showSize(size)
        }
        sizeApplied = sizeField != nil
        sizeField = nil
    }

    // MARK: Tabs

    /// The open tabs, even a lone one (so it can be torn off), scrolling sideways when they don't
    /// fit, with + (New tab) pinned at the right end; the shown one is highlighted and kept in view.
    /// Not in a pinned window, nor with a service that has no tabs.
    @ViewBuilder private var tabStrip: some View {
        if pinnedTab == nil, BrowserTabSelection.supportsTabs(model.state) {
            HStack(spacing: 0) {
                tabChips
                BrowserBarButton(icon: "plus", label: "New tab") {
                    model.newTab()
                    // Like Safari: a new tab starts in the address bar.
                    urlDraft = ""
                    editingUrl = true
                }
                .padding(.trailing, 4)
            }
            .background(c.bgElev)
            .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 0.5) }
        }
    }

    private var tabChips: some View {
        let tabs = BrowserTabSelection.strip(model.state)
        let tornOff = WindowDirectory.shared.tornOff(ticket.key)
        return ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(tabs) { tab in
                        let away = tornOff.browserTabs.contains(tab.id)
                        BrowserTabChip(
                            tab: tab, current: tab.id == model.selection.shown, away: away,
                            select: { model.selectTab(tab.id) }, close: { model.closeTab(tab.id) })
                            .tearOff(.pinned(ticket.key, .browser, browserTab: tab.id), tornOff: away) { model.selectTab(tab.id) }
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
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The page's title, when it says more than the address bar does.
    private var shownTitle: String? {
        guard let title = model.state?.title, !title.isEmpty, title != model.state?.url else { return nil }
        return title
    }

    private func status(_ title: String) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.scaled(size: 12.5)).foregroundStyle(c.text2).lineLimit(1)
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
                    cancelled: { model.touchCancelled() },
                    pinch: .init(
                        began: { model.pinchBegan($0, $1, at: $2) },
                        moved: { model.pinchMoved($0, $1) },
                        ended: { model.pinchEnded(at: $0) },
                        cancelled: { model.pinchCancelled() }))
                    .accessibilityElement()
                    .accessibilityLabel("Browser page. Tap to click, drag to scroll, hold then drag to select, pinch to zoom.")
                    .accessibilityValue(model.zoomed == nil ? "" : "Zoomed")
                    .accessibilityAction(named: "Reset zoom") { model.resetZoom() }
                if let window = tornOffShown {
                    TornOffPlaceholder(value: window, name: model.state?.tabs?.first { $0.id == window.browserTab }.map(BrowserTabSelection.label) ?? "This tab")
                } else if pinnedGone {
                    EmptyState(icon: "globe", title: "This tab was closed", message: "Close this window, or open another tab from the ticket's Browser tab.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(c.bgSunken)
                } else if model.empty {
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

    /// The browser tab shown here is torn off into a window of its own (not in that window itself).
    private var tornOffShown: TicketWindowValue? {
        guard pinnedTab == nil, let shown = model.selection.shown else { return nil }
        return WindowDirectory.shared.tornOff(ticket.key).window(ticket.key, tab: .browser, browserTab: shown)
    }

    /// A screenshot of the shown tab, opened in the annotator.
    private func annotate() {
        guard let client, let sink, !capturing else { return }
        capturing = true
        let id = sessionId
        let tab = model.selection.shown
        Task {
            defer { capturing = false }
            await model.settleSize()
            guard let shot = await actions.run(nil, { try await client.browserScreenshot(id, tabId: tab) }) else { return }
            guard let data = shot.png, let image = UIImage(data: data) else {
                haptic(.error)
                toasts.show("Couldn't read the page's screenshot.", kind: .error)
                return
            }
            // The screenshot as it is, uploaded on Add (closed without notes, it leaves nothing behind).
            let name = "\(Annotations.browserShotName(url: shot.url, title: shot.title)).png"
            let lookup = AnnotationElementLookup(sessionId: id, screenshot: shot)
            openAnnotator?(sink.request(.upload(data: data, name: name, mimeType: "image/png"), image: image, page: shot.page, lookup: lookup))
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

/// Desktop | Mobile as one segmented control. Tapping either half sends it, the selected one
/// included (it resets the tab to that mode's size and reloads), which a Picker wouldn't.
struct BrowserDeviceControl: View {
    let device: BrowserDevice
    let select: (BrowserDevice) -> Void
    @Environment(\.palette) private var c

    var body: some View {
        HStack(spacing: 2) {
            segment(.desktop, "Desktop")
            segment(.mobile, "Mobile")
        }
        .padding(2)
        .background(c.bgSunken, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.border, lineWidth: 0.5))
    }

    private func segment(_ value: BrowserDevice, _ label: String) -> some View {
        let on = device == value
        return Button {
            haptic(.tap)
            select(value)
        } label: {
            Text(label)
                .font(.scaled(size: 12.5, weight: on ? .semibold : .regular))
                .foregroundStyle(on ? c.accentText : c.text2)
                .padding(.horizontal, 10)
                .frame(height: 26)
                .background(on ? c.accentSoft : .clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? [.isSelected] : [])
        .accessibilityHint(on ? "Resets to the \(label.lowercased()) size and reloads" : "")
    }
}

/// The Responsive switch: lit while the tab follows this stage, lit dimmer while it follows
/// another window's (tapping then takes it over).
struct BrowserResponsiveButton: View {
    let lit: Bool
    let following: Bool
    let toggle: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        Button {
            haptic(.tap)
            toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up.left.and.arrow.down.right").font(.scaled(size: 11, weight: .semibold))
                Text("Responsive").font(.scaled(size: 12.5, weight: lit ? .semibold : .regular))
            }
            .foregroundStyle(lit || following ? c.accentText : c.text2)
            .opacity(following ? 0.6 : 1)
            .padding(.horizontal, 9)
            .frame(height: 30)
            .background(lit || following ? c.accentSoft.opacity(following ? 0.5 : 1) : c.bgSunken, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(lit || following ? .clear : c.border, lineWidth: 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Responsive")
        .accessibilityAddTraits(lit ? [.isSelected] : [])
        .accessibilityValue(lit ? "On" : following ? "Following another window" : "Off")
    }
}

/// One open tab in the strip: spinner while loading, its label (title, host, or "New Tab"), and a
/// close button. Tapping it switches to that tab. A suspended tab (its page closed to save memory)
/// is dimmed until it's opened, which reloads it.
struct BrowserTabChip: View {
    let tab: BrowserTab
    let current: Bool
    /// Torn off into a window of its own.
    var away = false
    let select: () -> Void
    let close: () -> Void
    @Environment(\.palette) private var c

    private var dimmed: Bool { tab.isSuspended && !current }

    var body: some View {
        let label = BrowserTabSelection.label(tab)
        HStack(spacing: 6) {
            if tab.loading { Spinner().controlSize(.mini) }
            if away { Image(systemName: "macwindow").font(.scaled(size: 10)).foregroundStyle(current ? c.accentText : c.text3) }
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
        .accessibilityValue([dimmed ? "Suspended, reloads when opened" : nil, away ? "In another window" : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAction { select() }
    }
}

/// A toolbar icon button: 34 pt, tap haptic, accent tint when active.
struct BrowserBarButton: View {
    let icon: String
    /// An SF Symbol to draw instead of the shared `icon`.
    var systemImage: String?
    let label: String
    var active = false
    /// A spinner in place of the icon (while its action is under way).
    var busy = false
    var disabled = false
    let action: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        Button {
            haptic(.tap)
            action()
        } label: {
            Group {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: systemImage ?? Icons.symbol(icon))
                }
            }
                .font(.scaled(size: 17, weight: .semibold))
                .foregroundStyle(active ? c.accentText : c.text2)
                .frame(width: 34, height: 34)
                .background(active ? c.accentSoft : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled && !busy ? 0.35 : 1)
        .accessibilityLabel(label)
    }
}
