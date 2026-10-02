import HarnessKit
import SwiftUI

/// The Details tab (TicketTabs.tsx DetailsTab): the title and brief, the settings rows
/// (TicketSettingsForm), then what it blocks, where it works, its remote ID and the tickets sharing
/// it, granted tools, auto-start, timestamps and its runs.
struct TicketDetailDetailsTab: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(\.openURL) private var openURL
    @State private var description = ""
    @FocusState private var editingBrief: Bool

    var body: some View {
        let state = store.state
        let editable = ticket.status != .done
        Form {
            Section("Title") {
                DraftField(value: ticket.title, prompt: "Title", alignment: .leading) { saveTitle($0) }
                    .disabled(!editable)
                    .accessibilityLabel("Title")
            }
            .listRowBackground(c.bgElev)
            Section(ticket.status == .planning ? "Plan / brief" : "Brief") {
                TextField("", text: $description, prompt: Text("What should the agent do?").foregroundStyle(c.text3), axis: .vertical)
                    .font(.system(size: 14.5))
                    .foregroundStyle(c.text)
                    // A long plan scrolls inside the field instead of pushing the settings off screen.
                    .lineLimit(5...10)
                    .lineSpacing(3)
                    .focused($editingBrief)
                    .disabled(!editable)
                    .accessibilityLabel(ticket.status == .planning ? "Plan / brief" : "Brief")
                if description != ticket.description {
                    HStack(spacing: 8) {
                        Text("Unsaved changes").font(.system(size: 13)).foregroundStyle(c.text3).frame(maxWidth: .infinity, alignment: .leading)
                        HButton("Revert", variant: .ghost, small: true, fullWidth: false) { description = ticket.description }
                        HButton("Save", variant: .primary, small: true, fullWidth: false) { saveDescription() }
                    }
                }
            }
            .listRowBackground(c.bgElev)
            Section {
                TicketSettingsForm(ticket: ticket) { patch($0) }
                readOnlyRows(state)
            }
            .listRowBackground(c.bgElev)
            let runs = TicketDetailLogic.runs(state, sessionId: ticket.sessionId)
            if !runs.isEmpty {
                Section("Runs") {
                    NowReader { now in
                        ForEach(runs, id: \.id) { r in runRow(r, now: now) }
                    }
                }
                .listRowBackground(c.bgElev)
            }
        }
        .scrollContentBackground(.hidden)
        .background(c.bg)
        .scrollDismissesKeyboard(.interactively)
        .ticketHeroScroll()
        .onAppear { description = ticket.description }
        .onChange(of: ticket.description) { _, d in description = d }
    }

    @ViewBuilder private func readOnlyRows(_ state: BoardState) -> some View {
        let dependents = state.dependentsOf(ticket)
        let related = Related.relatedOf(state.tickets, ticket, fetched: store.related.byTicket[ticket.id])
        if !dependents.isEmpty {
            LabeledContent("Blocks") {
                VStack(alignment: .trailing, spacing: 6) {
                    ForEach(dependents, id: \.key) { d in
                        Button { router.push(.ticket(key: d.key, tab: nil)) } label: {
                            HStack(spacing: 6) {
                                if let t = d.ticket { StatusDot(status: t.status) }
                                Text(d.ticket.map { Keys.keyLabel($0) } ?? d.key).font(.mono(13.5)).foregroundStyle(c.accentText)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        LabeledContent("Workdir") {
            Text(ticket.workdir ?? "Not prepared yet")
                .font(.mono(12.5))
                .foregroundStyle(ticket.workdir != nil ? c.text : c.text3)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        if let url = ticket.pullRequestUrl.optional {
            LabeledContent("Pull request") {
                Button(TicketDetailLogic.pullRequestShort(url)) { if let u = URL(string: url) { openURL(u) } }
                    .font(.system(size: 14))
                    .foregroundStyle(c.accentText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isLink)
            }
        }
        if let ref = ticket.externalRef {
            LabeledContent("External") {
                let text = Text("\(Text(ref.key).font(.mono(14)))\(ref.url != nil ? " ↗" : "")\(Text(" · \(TicketDetailLogic.externalSource(ref))").foregroundStyle(c.text3))")
                    .font(.system(size: 14))
                    .foregroundStyle(ref.url != nil ? c.accentText : c.text)
                    .multilineTextAlignment(.trailing)
                if let link = ref.url.flatMap(URL.init(string:)) {
                    Button { openURL(link) } label: { text }.buttonStyle(.plain).accessibilityAddTraits(.isLink)
                } else {
                    text
                }
            }
        }
        if !related.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text(TicketDetailLogic.relatedHeading(ticket))
                    .font(.system(size: 14))
                    .foregroundStyle(c.text2)
                    .padding(.bottom, 4)
                RelatedTicketRows(related: related) { router.push(.ticket(key: $0, tab: nil)) }
                    .padding(.horizontal, -13)
            }
        }
        LabeledContent("Allowed tools") {
            if ticket.allowedTools.isEmpty {
                Text("None granted").font(.system(size: 14)).foregroundStyle(c.text3)
            } else {
                FlowLayout(spacing: 4, alignment: .trailing) {
                    ForEach(ticket.allowedTools, id: \.self) { DepChip(label: $0, done: true) }
                }
            }
        }
        LabeledContent("Auto-start") {
            Text(ticket.autoStart ? "When dependencies are done" : "Off")
                .font(.system(size: 14))
                .foregroundStyle(ticket.autoStart ? c.text : c.text3)
        }
        LabeledContent("Created") { RelativeTimeText(ms: ticket.createdAt).font(.system(size: 14)).foregroundStyle(c.text) }
        LabeledContent("Updated") { RelativeTimeText(ms: ticket.updatedAt).font(.system(size: 14)).foregroundStyle(c.text) }
    }

    private func runRow(_ r: Run, now: Double) -> some View {
        let running = r.status == .running || r.status == .queued
        let tint: Color = r.status == .failed ? c.red : r.status == .succeeded ? c.green : c.text2
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                if running { Spinner() }
                Text(r.status.rawValue).font(.system(size: 13, weight: .semibold)).foregroundStyle(tint)
                Text(r.kind.rawValue).font(.system(size: 13)).foregroundStyle(c.text)
                Text(Format.driverLabel(r.driver, drivers: store.state.drivers)).font(.system(size: 13)).foregroundStyle(c.text3)
                Spacer(minLength: 0)
                Text(TicketDetailLogic.runTime(r, now: now)).font(.system(size: 12.5)).foregroundStyle(c.text3)
            }
            Text(TicketDetailLogic.runDetail(r))
                .font(.system(size: 13))
                .foregroundStyle(r.error != nil ? c.red : c.text3)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }

    private func saveTitle(_ draft: String) {
        // The ticket as it is now: a commit can fire with an older render's closure.
        let current = store.state.ticketByKey(ticket.key) ?? ticket
        let title = TicketDetailLogic.trim(draft)
        guard !title.isEmpty, title != current.title else { return }
        let key = current.key
        actions.perform { _ = try await store.connectedAPI().updateTicket(key, UpdateTicketBody(title: title)) }
    }

    private func saveDescription() {
        let key = ticket.key
        let text = description
        actions.perform("Saved") { _ = try await store.connectedAPI().updateTicket(key, UpdateTicketBody(description: text)) }
    }

    private func patch(_ body: UpdateTicketBody) {
        let key = ticket.key
        let relinks: Bool = if case .absent = body.externalRef { false } else { true }
        Task {
            let ok = await actions.run(TicketDetailLogic.patchToast(body)) { try await store.connectedAPI().updateTicket(key, body) }
            // A new remote ID has other tickets on it (some may not be loaded): fetch the list again.
            if ok != nil, relinks { _ = try? await store.loadDetail(key) }
        }
    }
}
