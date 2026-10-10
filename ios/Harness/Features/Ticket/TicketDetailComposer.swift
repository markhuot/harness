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
    @State private var sending = false
    @State private var focused = false

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
                attachmentTray(accepts: accepts)
            }
            HStack(alignment: .bottom, spacing: 8) {
                if accepts {
                    attachButton
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
                                      draft.focus(now, stored: ticket.messageDraft.optional)
                                  },
                                  fieldBox: MentionFieldBox(border: attention ? c.red : nil, cornerRadius: 22,
                                                            padding: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16),
                                                            glass: true),
                                  focusRequest: focusRequest,
                                  onSubmit: { send() })
                }
                sendButton(active: writing && !compacting, disabled: !canSend, hint: sendHint(empty: empty, accepts: accepts)) { send() }
            }
        }
        .padding(.top, 6)
        // At rest, concentric with the phone's corners (the one-line field is 44 tall, its ends
        // round at 22); over the keyboard while writing. A multi-line draft makes it taller, but its
        // bottom row still sits where a one-line field would, so 44 holds.
        .concentricBottomPadding(barHeight: 44, raised: focused, horizontal: 12, bottom: 8)
        .animation(.snappy, value: focused)
        // Another device's edit (or its send) shows here, unless this one is being typed in.
        .onChange(of: ticket.messageDraft.optional, initial: true) { _, saved in draft.sync(saved) }
        .onAppear { draft.onError = { _ in haptic(.error) } }
        // Leaving the ticket with the field focused sends no blur: the draft isn't being typed in anymore.
        .onDisappear { draft.focus(false, stored: ticket.messageDraft.optional) }
    }

    /// Prominent accent glass while writing (focused, or holding a message), plain glass with a dimmed
    /// arrow otherwise. Focused but empty it stays prominent and ignores taps rather than `.disabled`,
    /// which would grey the glass out.
    @ViewBuilder private func sendButton(active: Bool, disabled: Bool, hint: String, action: @escaping () -> Void) -> some View {
        let label = Group {
            if sending {
                ProgressView()
            } else {
                Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold))
            }
        }
        .frame(width: 30, height: 30)
        if active {
            Button { if !disabled { action() } } label: { label }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .tint(c.accent)
                .accessibilityLabel("Send")
                .accessibilityHint(disabled ? hint : "")
        } else {
            Button(action: action) { label.foregroundStyle(c.text3) }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .disabled(true)
                .accessibilityLabel("Send")
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

    /// The (+) button: a glass circle the send button's size, opening the Attach menu (Photos,
    /// Files, Paste). Off while sending and once the list is full.
    private var attachButton: some View {
        let full = outgoing.count + uploader.pending.count >= maxPromptAttachments
        return Menu {
            PromptAttachmentMenuItems(uploader: uploader, target: outgoing)
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(full || sending ? c.text3 : c.text)
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .disabled(full || sending)
        .accessibilityLabel("Attach")
        .accessibilityValue(outgoing.isEmpty ? "" : "\(outgoing.count) of \(maxPromptAttachments) attached")
    }

    /// The files going with the message, over the field: the shared list with a remove button per
    /// row and a spinner row per upload, in a glass card that scrolls past about three rows so it
    /// doesn't cover the tab.
    private func attachmentTray(accepts: Bool) -> some View {
        let tiles = outgoing.list.enumerated().map { i, a in
            PromptAttachmentTile(attachment: a, index: i, local: uploader.thumbnails[a.id])
        }
        let rows = tiles.count + uploader.pending.count
        // A row is 44 tall with 4 between, and an annotated one has its "N notes" line (about 26)
        // under it; three and a bit show before it scrolls.
        let notes = tiles.filter { $0.annotation != nil }.count
        let height = min(CGFloat(rows) * 48 - 4 + CGFloat(notes) * 26, 182)
        return VStack(alignment: .leading, spacing: 4) {
            ScrollView {
                EditablePromptAttachmentList(
                    tiles: tiles,
                    pending: uploader.pending,
                    uploader: uploader,
                    onRemove: sending ? nil : { outgoing.remove(at: $0.index) },
                    onAnnotate: { a, annotation in outgoing.annotate(a, annotation: annotation) }
                )
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: height)
            if !accepts {
                Text("Attachments can't go with an answer to the approval.")
                    .font(.scaled(size: 12))
                    .foregroundStyle(c.red)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .padding(.vertical, 6)
        .glassEffect(.regular, in: .rect(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attachments")
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
