import HarnessKit
import SwiftUI

/// The Spec tab, where a ticket opens: the ticket's living spec (markdown with nested lists and
/// inline images), what it depends on, the files attached to its prompt, and a history bar over it. The bar scrubs through the spec's
/// revisions with the timeline along its bottom edge (loaded as they're needed), tags the approved plan, and follows the newest
/// revision as it lands unless the user has scrubbed back (SpecScrubber). Show changes keeps the
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
                    if let failed {
                        Callout(tone: .red, icon: "alert", title: "Couldn't load this revision", message: failed)
                    }
                    if let previous {
                        if let body, let previousBody {
                            if MarkdownDiff.unchanged(MarkdownCache.shared.diff(previousBody, body)) {
                                EmptyState(icon: "check", title: "No changes", message: "Rev \(rev) has the same text as rev \(previous).")
                                    .padding(.top, 20)
                            } else {
                                MarkdownView(text: body, previous: previousBody, size: 16, lineHeight: 1.5)
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
                            MarkdownView(text: body, size: 16, lineHeight: 1.5, annotatable: true)
                        }
                    } else {
                        Spinner().frame(maxWidth: .infinity).padding(30)
                    }
                    if let list = ticket.promptAttachments, !list.isEmpty {
                        Divider().overlay(c.border).padding(.top, 4)
                        TicketPromptAttachments(list: list)
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

/// The bar over the spec: when the revision on show was written, the approved-plan tag, the
/// revision's note and Show changes in one row, with the revision timeline (SpecTimeline) as its
/// bottom edge. The count ("Rev 7 of 12") shows in the timeline's bubble while dragging.
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
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        if !line.meta.isEmpty || line.baseline {
                            HStack(spacing: 6) {
                                if !line.meta.isEmpty { Text(line.meta).font(.scaled(size: 12.5)).foregroundStyle(c.text3).lineLimit(1) }
                                if line.baseline {
                                    Text(SpecHistory.baselineLabel)
                                        .font(.scaled(size: 11, weight: .semibold))
                                        .foregroundStyle(c.green)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(c.greenSoft, in: .capsule)
                                        .fixedSize()
                                }
                            }
                        }
                        if !line.note.isEmpty {
                            Text(line.note).font(.scaled(size: 12.5)).italic().foregroundStyle(c.text2).lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(SpecHistory.accessibilityLabel(line))
                    if latest > 1 { showChangesButton(rev: rev) }
                }
                .padding(.horizontal, 14)
                .padding(.top, 6)
                .padding(.bottom, latest > 1 ? 0 : 6)
                if latest > 1 {
                    SpecTimeline(latest: latest, shown: rev, baseline: SpecHistory.baseline(store.state, ticket: ticket)) {
                        scrubber.show($0, latest: latest)
                    }
                }
            }
            .background(c.bgElev)
            .overlay(alignment: .bottom) {
                if latest <= 1 { Rectangle().fill(c.border).frame(height: 1 / 3) }
            }
        }
    }

    private func showChangesButton(rev: Int) -> some View {
        let on = showChanges && rev > 1
        return Button {
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

/// The history bar's bottom edge: one segment per revision, rising from the bar's bottom line. The
/// revision on show stands taller in the accent color and the approved plan is green; the rest are
/// neutral, darker up to the one on show. Press anywhere and drag to sweep through the revisions,
/// with a selection tick each time the finger crosses into another one and a bubble above the
/// finger naming it ("Rev 7 of 12"). The touch area is taller
/// than the strip draws, and the segments grow while a finger is on it. The gaps close up once
/// there are too many revisions to space out.
private struct SpecTimeline: View {
    let latest: Int
    let shown: Int
    let baseline: Int?
    let onScrub: (Int) -> Void

    @Environment(\.palette) private var c
    /// Where the finger is along the strip while dragging, for the bubble
    @State private var dragX: Double?
    @State private var bubbleWidth: Double = 0

    private var dragging: Bool { dragX != nil }

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let gap = min(2, max(0, width / Double(latest) - 4))
            HStack(alignment: .bottom, spacing: gap) {
                ForEach(1...latest, id: \.self) { rev in
                    let tone = SpecHistory.segmentTone(rev: rev, shown: shown, baseline: baseline)
                    UnevenRoundedRectangle(topLeadingRadius: 1.5, topTrailingRadius: 1.5)
                        .fill(color(tone))
                        .frame(maxWidth: .infinity)
                        .frame(height: height(tone))
                }
            }
            .frame(width: width, height: geo.size.height, alignment: .bottom)
            .contentShape(.rect)
            .overlay(alignment: .topLeading) {
                if let dragX {
                    Text(shown == baseline ? "Rev \(shown) of \(latest) · \(SpecHistory.baselineLabel)" : "Rev \(shown) of \(latest)")
                        .font(.scaled(size: 12.5, weight: .semibold))
                        .foregroundStyle(c.text)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(c.bgElev, in: .capsule)
                        .overlay(Capsule().stroke(c.border, lineWidth: 1 / 2))
                        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                        .fixedSize()
                        .onGeometryChange(for: Double.self) { $0.size.width } action: { bubbleWidth = $0 }
                        // Above the finger (the hand covers what's below it), over the bar's row,
                        // kept on screen at either end.
                        .offset(x: min(max(4, dragX - bubbleWidth / 2), width - bubbleWidth - 4), y: -26)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        dragX = v.location.x
                        let rev = SpecHistory.revisionAt(v.location.x, width: width, latest: latest)
                        if rev != shown {
                            haptic(.select)
                            onScrub(rev)
                        }
                    }
                    .onEnded { _ in dragX = nil }
            )
        }
        .frame(height: 24)
        .animation(.snappy(duration: 0.15), value: dragging)
        .accessibilityElement()
        .accessibilityLabel("Revision")
        .accessibilityValue(shown == baseline ? "\(shown) of \(latest), \(SpecHistory.baselineLabel)" : "\(shown) of \(latest)")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: onScrub(min(latest, shown + 1))
            case .decrement: onScrub(max(1, shown - 1))
            @unknown default: break
            }
        }
    }

    private func color(_ tone: SpecHistory.SegmentTone) -> Color {
        switch tone {
        case .shown: c.accent
        case .baseline: c.green
        case .before: c.text3.opacity(0.55)
        case .after: c.borderStrong
        }
    }

    private func height(_ tone: SpecHistory.SegmentTone) -> Double {
        let base: Double = dragging ? 6 : 3
        return tone == .shown ? base + 4 : base
    }
}

/// The files the human attached to the ticket's New session, read-only at the bottom of the spec as
/// a vertical list: images open full screen,
/// other files download into Quick Look. One that's gone from the Mac shows as missing.
private struct TicketPromptAttachments: View {
    let list: [Attachment]

    @State private var downloading = false

    var body: some View {
        let tiles = list.enumerated().map { i, a in PromptAttachmentTile(attachment: a, index: i) }
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                SectionTitle("Attachments")
                if downloading { ProgressView().controlSize(.mini) }
            }
            OpenablePromptAttachmentList(tiles: tiles, downloading: $downloading)
        }
    }
}
