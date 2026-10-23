import HarnessKit
import SwiftUI

// The message composer's pieces, shared by a ticket's composer (TicketDetailComposer) and the chief
// of staff's chat (CosChatView), so both look and behave alike: the glass (+) and send buttons and
// the tray of files waiting to go.

/// Prominent accent glass while writing (focused, or holding a message), plain glass with a dimmed
/// arrow otherwise. Focused but empty it stays prominent and ignores taps rather than `.disabled`,
/// which would grey the glass out.
struct ComposerSendButton: View {
    let sending: Bool
    let active: Bool
    let disabled: Bool
    let hint: String
    let action: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
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
}

/// The (+) button: a glass circle the send button's size, opening the Attach menu (Photos,
/// Files, Paste). Off while sending and once the list is full.
struct ComposerAttachButton: View {
    let uploader: PromptAttachmentUploader
    let outgoing: MessageAttachments
    let sending: Bool

    @Environment(\.palette) private var c

    var body: some View {
        let full = outgoing.count + uploader.pending.count >= maxPromptAttachments
        Menu {
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
}

/// The files going with the message, over the field: the shared list with a remove button per
/// row and a spinner row per upload, in a glass card that scrolls past about three rows so it
/// doesn't cover the screen. `accepts` false adds the note that they can't go (an approval waits).
struct ComposerAttachmentTray: View {
    let uploader: PromptAttachmentUploader
    let outgoing: MessageAttachments
    let sending: Bool
    var accepts = true

    @Environment(\.palette) private var c

    var body: some View {
        let tiles = outgoing.list.enumerated().map { i, a in
            PromptAttachmentTile(attachment: a, index: i, local: uploader.thumbnails[a.id])
        }
        let rows = tiles.count + uploader.pending.count
        // A row is 44 tall with 4 between, and an annotated one has its "N notes" line (about 26)
        // under it; three and a bit show before it scrolls.
        let notes = tiles.filter { $0.annotation != nil }.count
        let height = min(CGFloat(rows) * 48 - 4 + CGFloat(notes) * 26, 182)
        VStack(alignment: .leading, spacing: 4) {
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
}
