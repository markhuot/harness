import HarnessKit
import QuickLook
import SwiftUI

/// The Spec tab, where a ticket opens: the ticket's living spec (markdown with nested lists and
/// inline images), what it depends on, the files attached to its prompt, and a history bar over it. The bar steps and scrubs through
/// the spec's revisions (loaded as they're needed), tags the approved plan, and follows the newest
/// revision as it lands unless the user has stepped back (SpecScrubber). Show changes keeps the
/// rendered spec and marks what the shown revision changed from the one before it, in place
/// (MarkdownView with `previous`).
struct TicketDetailSpecTab: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @State private var scrubber = SpecScrubber()
    @State private var showChanges = false
    @State private var failed: String?
    /// Why the revision Show changes compares with couldn't load
    @State private var previousFailed: String?

    var body: some View {
        let state = store.state
        let latest = SpecHistory.latest(ticket)
        let rev = scrubber.shown(latest: latest)
        let previous = showChanges ? SpecHistory.previous(rev) : nil
        let body = state.specBody(ticket.id, rev: rev)
        let previousBody = previous.flatMap { state.specBody(ticket.id, rev: $0) }
        let deps = state.dependencyStates(ticket)
        VStack(spacing: 0) {
            SpecHistoryBar(ticket: ticket, scrubber: $scrubber, showChanges: $showChanges, latest: latest)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !deps.isEmpty {
                        FlowLayout(spacing: 6) {
                            SectionTitle("Depends on")
                            ForEach(deps, id: \.key) { d in
                                let opens = Related.depOpens(key: d.key, missing: d.missing, byRemoteKey: store.related.byRemoteKey)
                                DepChip(label: d.ticket.map { Keys.keyLabel($0) } ?? d.key, done: d.done, unknown: d.state == .unknown,
                                        onTap: opens ? { router.push(.ticket(key: d.ticket?.key ?? d.key, tab: nil)) } : nil)
                            }
                        }
                    }
                    if let list = ticket.promptAttachments, !list.isEmpty {
                        TicketPromptAttachments(ticket: ticket, list: list)
                    }
                    if let failed {
                        Callout(tone: .red, icon: "alert", title: "Couldn't load this revision", message: failed)
                    }
                    if let previous {
                        if let body, let previousBody {
                            if MarkdownDiff.unchanged(MarkdownCache.shared.diff(previousBody, body)) {
                                EmptyState(icon: "check", title: "No changes", message: "Rev \(rev) has the same text as rev \(previous).")
                                    .padding(.top, 20)
                            } else {
                                MarkdownView(text: body, previous: previousBody)
                            }
                        } else if let previousFailed {
                            Callout(tone: .red, icon: "alert", title: "Couldn't load the changes", message: previousFailed)
                        } else if failed == nil {
                            Spinner().frame(maxWidth: .infinity).padding(30)
                        }
                    } else if let body {
                        if TicketDetailLogic.trim(body).isEmpty {
                            EmptyState(icon: "fileText", title: "No spec yet",
                                       message: ticket.status == .planning ? "The planning agent writes it. You can also write it in Details." : "This revision is empty.")
                                .padding(.top, 20)
                        } else {
                            MarkdownView(text: body)
                        }
                    } else {
                        Spinner().frame(maxWidth: .infinity).padding(30)
                    }
                }
                .padding(14)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .ticketHeroScroll()
        }
        // The revision list: once, and again when a revision it doesn't have shows up.
        .task(id: "\(ticket.id)#\(latest)#\(store.epoch)") {
            guard SpecHistory.needsRevisions(store.state, ticketId: ticket.id, latest: latest), let api = store.api else { return }
            if let list = try? await api.specRevisions(ticket.key) {
                store.dispatch(.specRevisions(ticketId: ticket.id, revisions: list))
            }
        }
        // An older revision's body, the first time it's shown.
        .task(id: "\(ticket.id)#\(rev)") {
            failed = nil
            guard store.state.specBody(ticket.id, rev: rev) == nil, let api = store.api else { return }
            do {
                let r = try await api.specRevision(ticket.key, rev: rev)
                store.dispatch(.specRevision(ticketId: ticket.id, revision: r))
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { failed = errorMessage(error) }
            }
        }
        // The revision Show changes compares with, the first time it's needed.
        .task(id: previous.map { "\(ticket.id)#\($0)" }) {
            previousFailed = nil
            guard let previous, store.state.specBody(ticket.id, rev: previous) == nil, let api = store.api else { return }
            do {
                let r = try await api.specRevision(ticket.key, rev: previous)
                store.dispatch(.specRevision(ticketId: ticket.id, revision: r))
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { previousFailed = errorMessage(error) }
            }
        }
    }
}

/// The bar over the spec: "Rev 7 of 7 · Agent · 3m ago", the approved-plan tag, the revision's
/// note, ‹ › to step, a slider to scrub, a Latest button while pinned, and Show changes.
private struct SpecHistoryBar: View {
    let ticket: Ticket
    @Binding var scrubber: SpecScrubber
    @Binding var showChanges: Bool
    let latest: Int

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    var body: some View {
        let rev = scrubber.shown(latest: latest)
        let info = SpecHistory.info(store.state, ticketId: ticket.id, rev: rev)
        NowReader { now in
            let line = SpecHistory.line(rev: rev, latest: latest, info: info, now: now)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    stepButton(-1, icon: "chevronLeft", label: "Previous revision")
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(line.title).font(.scaled(size: 13.5, weight: .semibold)).foregroundStyle(c.text)
                            if !line.meta.isEmpty { Text(line.meta).font(.scaled(size: 12.5)).foregroundStyle(c.text3).lineLimit(1) }
                            if line.baseline {
                                Text(SpecHistory.baselineLabel)
                                    .font(.scaled(size: 11, weight: .semibold))
                                    .foregroundStyle(c.green)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(c.greenSoft, in: .capsule)
                            }
                        }
                        if !line.note.isEmpty {
                            Text(line.note).font(.scaled(size: 12.5)).italic().foregroundStyle(c.text2).lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(SpecHistory.accessibilityLabel(line))
                    if !scrubber.following {
                        Button("Latest") {
                            haptic(.select)
                            scrubber.follow()
                        }
                        .font(.scaled(size: 12.5, weight: .semibold))
                        .foregroundStyle(c.accentText)
                        .buttonStyle(.plain)
                    }
                    stepButton(1, icon: "chevronRight", label: "Next revision")
                }
                HStack(spacing: 10) {
                    if latest > 1 {
                        Slider(value: Binding(get: { Double(rev) }, set: { scrubber.show(Int($0.rounded()), latest: latest) }),
                               in: 1...Double(latest), step: 1)
                            .tint(c.accent)
                            .accessibilityLabel("Revision")
                            .accessibilityValue("\(rev) of \(latest)")
                    } else {
                        Spacer(minLength: 0)
                    }
                    let on = showChanges && rev > 1
                    Button {
                        haptic(.select)
                        showChanges.toggle()
                    } label: {
                        HStack(spacing: 5) {
                            Icon(on ? "check" : "branch", size: 11, weight: .semibold)
                            Text("Show changes").font(.scaled(size: 13, weight: .medium))
                        }
                        .foregroundStyle(rev <= 1 ? c.text3 : on ? c.onAccent : c.text2)
                        .padding(.horizontal, 10)
                        .frame(height: 28)
                        .background(on ? c.accent : c.bgActive, in: .capsule)
                        .contentShape(.capsule)
                    }
                    .buttonStyle(.plain)
                    .fixedSize()
                    .disabled(rev <= 1)
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityHint(rev <= 1 ? "The first revision has nothing to compare with" : "Compares this revision with the one before it")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(c.bgElev)
            .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
        }
    }

    private func stepButton(_ delta: Int, icon: String, label: String) -> some View {
        let enabled = scrubber.canStep(delta, latest: latest)
        return Button {
            haptic(.select)
            scrubber.step(delta, latest: latest)
        } label: {
            Icon(icon, size: 15, weight: .semibold)
                .foregroundStyle(enabled ? c.text : c.text3.opacity(0.5))
                .frame(width: 32, height: 32)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}

/// The files the human attached to the ticket's New session, read-only: images open full screen,
/// other files download into Quick Look. One that's gone from the Mac shows as missing.
private struct TicketPromptAttachments: View {
    let ticket: Ticket
    let list: [PromptAttachment]

    @Environment(BoardStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @State private var viewing: AttachmentViewerStart?
    @State private var preview: URL?
    @State private var downloading = false

    var body: some View {
        let tiles = list.enumerated().map { i, a in PromptAttachmentTile(attachment: a, index: i, remote: (key: ticket.key, index: i)) }
        let images = tiles.filter(\.isImage)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                SectionTitle("Attachments")
                if downloading { ProgressView().controlSize(.mini) }
            }
            PromptAttachmentStrip(tiles: tiles, onOpen: { tile in
                if tile.isImage {
                    guard let i = images.firstIndex(where: { $0.index == tile.index }) else { return }
                    var t = Transaction()
                    t.disablesAnimations = true
                    withTransaction(t) { viewing = AttachmentViewerStart(index: i) }
                } else {
                    open(tile)
                }
            })
        }
        .fullScreenCover(item: $viewing) { start in
            let key = ticket.key
            let api = store.api
            AttachmentViewer(
                attachments: images.map { Attachment(id: String($0.index), kind: .image, mimeType: "", name: $0.attachment.name, size: 0) },
                start: start.index,
                url: { a in Int(a.id).flatMap { api?.promptAttachmentUrl(key: key, index: $0) } }
            ) {
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { viewing = nil }
            }
        }
        .quickLookPreview($preview)
    }

    /// Download a file into a temporary folder under its own name, then show it in Quick Look.
    private func open(_ tile: PromptAttachmentTile) {
        guard !downloading, let api = store.api, let url = URL(string: api.promptAttachmentUrl(key: ticket.key, index: tile.index)) else { return }
        downloading = true
        let name = tile.attachment.name
        Task {
            defer { downloading = false }
            do {
                let (temp, response) = try await URLSession.shared.download(from: url)
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    throw HarnessAPIError(status: http.statusCode, message: http.statusCode == 404 ? "The file is gone from the Mac." : HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
                }
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent("prompt-attachments/\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let dest = dir.appendingPathComponent(name.isEmpty ? "file" : name)
                try FileManager.default.moveItem(at: temp, to: dest)
                preview = dest
            } catch {
                haptic(.error)
                toasts.show("Couldn't open \(name): \(localizedErrorMessage(error))", kind: .error)
            }
        }
    }
}
