import HarnessKit
import SwiftUI

// The ticket screen's sheets (Request changes, Approve and…). Each draws its own header (Cancel,
// the title over the key, the primary action) rather
// than toolbar items, because AXe doesn't see a sheet's toolbar and sim-check taps "Cancel" and
// "Approve" by label.

/// A sheet's frame: the header, then the body in a scroll view over the theme background.
struct TicketDetailSheetFrame<Primary: View, Content: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var primary: Primary
    @ViewBuilder var content: Content

    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var c

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                HButton("Cancel", variant: .ghost, fullWidth: false, haptic: nil) { dismiss() }
                VStack(spacing: 1) {
                    Text(title).font(.scaled(size: 16, weight: .semibold)).foregroundStyle(c.text).lineLimit(1)
                    if let subtitle { Text(subtitle).font(.mono(12)).foregroundStyle(c.text3).lineLimit(1) }
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                primary
            }
            .padding(14)
            .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) { content }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(c.bg)
        .presentationDetents([.large])
        .toastOverlay()
    }
}

/// A multiline field in a sheet's body.
struct TicketDetailSheetField: View {
    @Binding var text: String
    let placeholder: String
    var minHeight: CGFloat = 110
    var accessibilityLabel: String?
    var autoFocus = false

    @Environment(\.palette) private var c
    @FocusState private var focused: Bool

    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(c.text3), axis: .vertical)
            .font(.scaled(size: 16))
            .foregroundStyle(c.text)
            .lineLimit(4...)
            .focused($focused)
            .frame(minHeight: minHeight, alignment: .topLeading)
            .padding(12)
            .background(c.bgElev, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(c.border))
            .accessibilityLabel(accessibilityLabel ?? placeholder)
            .task {
                guard autoFocus else { return }
                // After the sheet's presentation, or the keyboard doesn't come up.
                try? await Task.sleep(for: .milliseconds(350))
                focused = true
            }
    }
}

/// Notes for the agent that send the ticket back to In progress: request changes (review) or
/// re-open (done).
struct TicketDetailNotesSheet: View {
    let ticket: Ticket
    var reopen = false

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var c
    @State private var notes = ""

    var body: some View {
        TicketDetailSheetFrame(title: reopen ? "Re-open" : "Request changes", subtitle: Keys.keyLabel(ticket)) {
            HButton("Send", variant: .primary, fullWidth: false) { submit() }
                .disabled(TicketDetailLogic.trim(notes).isEmpty)
        } content: {
            TicketDetailSheetField(text: $notes, placeholder: reopen ? "What should the agent do now?" : "What should the agent change?", minHeight: 160, autoFocus: true)
            Text(reopen
                ? "The ticket moves from Done back to In progress and the agent gets your notes. If its worktree was removed, it's recreated."
                : "The ticket moves back to In progress and the agent gets your notes.")
                .font(.scaled(size: 13))
                .foregroundStyle(c.text3)
        }
    }

    private func submit() {
        let key = ticket.key
        let text = notes
        Task {
            let ok: Ticket? = if reopen {
                await actions.run("Re-opened") { try await store.connectedAPI().reopenTicket(key, ReopenBody(notes: text)) }
            } else {
                await actions.run("Changes requested") { try await store.connectedAPI().humanReview(key, HumanReviewBody(decision: .requestChanges, notes: text)) }
            }
            if ok != nil { dismiss() }
        }
    }
}

/// "Approve and…": approve with instructions for the completion run.
struct TicketDetailApproveCustomSheet: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var c
    @State private var instructions: String

    init(ticket: Ticket) {
        self.ticket = ticket
        _instructions = State(initialValue: TicketDetailLogic.approveCustomInitial(ticket))
    }

    var body: some View {
        TicketDetailSheetFrame(title: "Approve and…", subtitle: Keys.keyLabel(ticket)) {
            HButton("Approve", variant: .primary, fullWidth: false, haptic: nil) { submit() }
                .disabled(TicketDetailLogic.trim(instructions).isEmpty)
        } content: {
            TicketDetailSheetField(text: $instructions, placeholder: "What should the agent do with the work? e.g. “deploy it to staging, then open a PR”",
                                   minHeight: 140, accessibilityLabel: "Completion instructions", autoFocus: true)
            Text("Once the ticket is ready, the agent finishes the work following these instructions and marks it done.")
                .font(.scaled(size: 13))
                .foregroundStyle(c.text3)
        }
    }

    private func submit() {
        guard let api = store.api,
              case let .review(body) = Approve.approveRequest(.action(.custom), instructions: instructions) else { return }
        let key = ticket.key
        Task {
            if await actions.run("Approved", { try await api.humanReview(key, body) }) != nil {
                haptic(.success)
                dismiss()
            }
        }
    }
}
