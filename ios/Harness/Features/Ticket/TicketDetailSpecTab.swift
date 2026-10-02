import HarnessKit
import SwiftUI

/// The Spec tab, where a ticket opens: the ticket's living spec (markdown with nested lists and
/// inline images), what it depends on, and a history bar over it. The bar steps and scrubs through
/// the spec's revisions (loaded as they're needed), tags the approved plan, and follows the newest
/// revision as it lands unless the user has stepped back (SpecScrubber). Show changes draws the
/// shown revision's diff against the one before it, with the Changes tab's rows.
struct TicketDetailSpecTab: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @State private var scrubber = SpecScrubber()
    @State private var showChanges = false
    /// Diffs fetched so far, by "from-to"; revisions never change, so neither do these
    @State private var diffs: [String: String] = [:]
    @State private var failed: String?

    var body: some View {
        let state = store.state
        let latest = SpecHistory.latest(ticket)
        let rev = scrubber.shown(latest: latest)
        let previous = SpecHistory.previous(rev)
        let body = state.specBody(ticket.id, rev: rev)
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
                    if showChanges, let previous {
                        if let diff = diffs["\(previous)-\(rev)"] {
                            SpecDiffView(diff: diff, text: body ?? "", from: previous, to: rev)
                        } else {
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
        .task(id: showChanges ? previous.map { "\(ticket.id)#\($0)-\(rev)" } : nil) {
            guard showChanges, let previous, diffs["\(previous)-\(rev)"] == nil, let api = store.api else { return }
            do {
                let d = try await api.specDiff(ticket.key, from: previous, to: rev)
                diffs["\(previous)-\(rev)"] = d.diff
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { failed = errorMessage(error) }
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
                    Toggle(isOn: $showChanges) {
                        Text("Show changes").font(.scaled(size: 13)).foregroundStyle(rev > 1 ? c.text2 : c.text3)
                    }
                    .toggleStyle(.switch)
                    .tint(c.accent)
                    .fixedSize()
                    .disabled(rev <= 1)
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

/// One revision's changes against the one before, drawn with the Changes tab's line and gap rows.
/// The unchanged runs between hunks expand from the newer revision's body.
private struct SpecDiffView: View {
    let diff: String
    /// The newer revision's text
    let text: String
    let from: Int
    let to: Int

    @Environment(\.palette) private var c
    @State private var expanded: Set<Int> = []

    var body: some View {
        if let file = SpecHistory.diff(diff) {
            let rows = ChangesRows.rows(file, contents: ChangesRows.lines(of: text), expanded: expanded)
            let gutter = CGFloat(String(max(1, ChangesRows.lines(of: text).count)).count) * 7.2 + 4
            VStack(alignment: .leading, spacing: 0) {
                Text("Changes from rev \(from) to rev \(to)")
                    .font(.scaled(size: 12.5, weight: .semibold))
                    .foregroundStyle(c.text3)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(rows.indices, id: \.self) { i in
                    switch rows[i] {
                    case let .gap(g):
                        ChangesGapRow(gap: g, loading: false) { expanded.insert(g.index) }
                    case let .line(l):
                        ChangesLineRow(line: l, highlighted: nil, result: nil, gutter: gutter)
                    }
                }
            }
            .background(c.bgElev, in: .rect(cornerRadius: 10))
            .clipShape(.rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(c.border, lineWidth: 1 / 3))
        } else {
            EmptyState(icon: "check", title: "No changes", message: "Rev \(to) has the same text as rev \(from).")
        }
    }
}
