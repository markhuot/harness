import HarnessKit
import SwiftUI

/// The message composer under every tab: @file mentions and /commands,
/// a placeholder for the ticket's state (red while it's blocked on the human), and a send button
/// that stands out while writing: once the field is focused, and after a blur only while it holds a
/// message. A message goes to the agent and shows in the Transcript, never in Activity, so a send that goes through
/// opens the Transcript from any tab (Tabs.tabAfterSend). The attach (+) button, field and send
/// button are Liquid Glass floating over the tab, with no bar of their own. Files picked from (+)
/// (or dropped on the ticket) upload first and wait in a short list over the field, each removable,
/// and go with the next message; there's no (+) while a tool approval waits, since a message then
/// answers it. An image annotated anywhere on the ticket joins that list with its notes (or an
/// image already there gets them), and the field takes focus so the human can say why; images in
/// the list open full screen with Annotate, which edits their notes in place.
///
/// The text and files are the ticket's message draft (DESIGN.md "Message drafts", MessageDraftSync):
/// saved to the service as they're typed, so the message can be finished on another device, and
/// replaced by another device's draft only while the field doesn't have focus.
struct TicketDetailComposer: View {
    let ticket: Ticket
    /// The tab on screen
    let tab: TicketTab
    /// The message being written: its text and the files going with it
    let draft: MessageDraftSync
    let uploader: PromptAttachmentUploader
    /// Focus the field each time this changes (an annotated image just joined the message)
    var focusRequest = 0
    /// Shows a tab of the ticket: the Transcript once a message went through
    let onTab: (TicketTab) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(Router.self) private var router
    @Environment(\.inTicketSheet) private var inTicketSheet
    @Environment(\.inTicketPanel) private var inTicketPanel
    @Environment(DockedSheetInset.self) private var dockInset: DockedSheetInset?
    @State private var sending = false
    @State private var focused = false

    @Environment(\.sheetFront) private var sheetFront
    @Environment(\.sheetResting) private var sheetResting

    /// The phone's ticket sheet floats the docked cards above its composer; the iPad's panel doesn't.
    private var keepsRoom: Bool { inTicketSheet && !inTicketPanel }

    /// Tells the sheet its screen has a composer while it's the front sheet's.
    private func reportUp() {
        guard keepsRoom, sheetFront, dockInset?.composerUp != true else { return }
        dockInset?.composerUp = true
    }

    private var outgoing: MessageAttachments { draft.attachments }
    private var text: String { draft.text }
    /// The session is compacting: the service refuses messages until it ends.
    private var compacting: Bool { ticket.compacting == true }

    var body: some View {
        let empty = TicketDetailLogic.trim(text).isEmpty
        let writing = focused || !empty || !outgoing.isEmpty
        let attention = ticket.status == .blocked
        let accepts = TicketDetailLogic.acceptsMessageAttachments(ticket)
        let canSend = TicketDetailLogic.canSendMessage(text: text, attachments: outgoing.count, uploading: uploader.pending.count,
                                                       sending: sending, approvalPending: !accepts,
                                                       compacting: compacting)
        VStack(spacing: 4) {
            if !outgoing.isEmpty || !uploader.pending.isEmpty {
                ComposerAttachmentTray(uploader: uploader, outgoing: outgoing, sending: sending, accepts: accepts)
            }
            HStack(alignment: .bottom, spacing: 8) {
                if accepts {
                    ComposerAttachButton(uploader: uploader, outgoing: outgoing, sending: sending)
                }
                if compacting {
                    compactingField
                } else {
                MentionTextEditor(text: Binding(get: { draft.text }, set: { draft.setText($0) }),
                                  placeholder: TicketDetailLogic.composerPlaceholder(ticket),
                                  ticketKey: ticket.key,
                                  minLines: 1,
                                  maxLines: 6,
                                  suggestionsEdge: .top,
                                  suggestionsMaxHeight: 200,
                                  fieldLabel: "Message the agent",
                                  placeholderColor: attention ? c.red : nil,
                                  onFocusChange: { now in
                                      focused = now
                                      TicketViewMemory.shared.focusChanged(now, key: ticket.key, at: DockHold.now)
                                      draft.focus(now, stored: ticket.messageDraft.optional)
                                  },
                                  fieldBox: MentionFieldBox(border: attention ? c.red : nil, cornerRadius: 22,
                                                            padding: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16),
                                                            glass: true),
                                  focusRequest: focusRequest,
                                  onSubmit: { send() })
                }
                ComposerSendButton(sending: sending, active: writing && !compacting, disabled: !canSend, hint: sendHint(empty: empty, accepts: accepts)) { send() }
            }
        }
        .onChange(of: sheetFront) { reportUp() }
        .onAppear { reportUp() }
        .padding(.top, 6)
        // At rest, concentric with the phone's corners (the one-line field is 44 tall, its ends
        // round at 22); over the keyboard while writing. A multi-line draft makes it taller, but its
        // bottom row still sits where a one-line field would, so 44 holds.
        .concentricBottomPadding(barHeight: DockMetrics.barHeight, raised: focused, horizontal: 12, bottom: 8)
        .animation(.snappy, value: focused)
        // Another device's edit (or its send) shows here, unless this one is being typed in.
        .onChange(of: ticket.messageDraft.optional, initial: true) { _, saved in draft.sync(saved) }
        .onAppear { draft.onError = { _ in haptic(.error) } }
        // Leaving the ticket with the field focused sends no blur: the draft isn't being typed in anymore.
        .onDisappear {
            if keepsRoom, sheetFront { dockInset?.composerUp = false }
            TicketViewMemory.shared.composerDisappeared(key: ticket.key, at: DockHold.now)
            draft.focus(false, stored: ticket.messageDraft.optional)
        }
    }

    /// The field while the session compacts: a spinner and "Compacting…", no input.
    private var compactingField: some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(TicketDetailLogic.composerPlaceholder(ticket))
                .font(.body)
                .foregroundStyle(c.text3)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Compacting…")
        .accessibilityIdentifier("composer-compacting")
    }

    /// Why Send ignores a tap (VoiceOver's hint).
    private func sendHint(empty: Bool, accepts: Bool) -> String {
        if !uploader.pending.isEmpty { return "Wait for the attachments to upload" }
        if !outgoing.isEmpty && !accepts { return "Remove the attachments to answer the approval" }
        return empty ? "Write a message first" : ""
    }

    private func send() {
        let body = TicketDetailLogic.trim(text)
        let accepts = TicketDetailLogic.acceptsMessageAttachments(ticket)
        guard TicketDetailLogic.canSendMessage(text: text, attachments: outgoing.count, uploading: uploader.pending.count,
                                               sending: sending, approvalPending: !accepts, compacting: compacting) else { return }
        let files = outgoing.list
        let attachments = outgoing.inputs
        let key = ticket.key
        sending = true
        Task {
            // No draft save may land after the message: the service clears the draft when it goes.
            await draft.beforeSend()
            // No client: connectedAPI throws, so it plays the error haptic rather than dropping the message silently.
            let ok = await actions.run { try await store.connectedAPI().sendMessage(key, text: body, attachments: attachments) }
            sending = false
            if let ok {
                haptic(.success)
                store.dispatch(.tickets([ok]))
                // Files attached while it was sending stay for the next message.
                draft.sent(files: files)
            } else {
                draft.sendFailed()
            }
            let next = Tabs.tabAfterSend(tab, sent: ok != nil)
            if next != tab { onTab(next) }
        }
    }
}
