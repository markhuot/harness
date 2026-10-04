import HarnessKit
import SwiftUI

// The New session's attachments. Picking, uploading and drag and drop are shared with the ticket
// composer: PromptAttachmentUploader, PromptAttachmentPickers and PromptAttachmentDrop
// (Content/PromptAttachmentUploader.swift), with NewSessionEditor as the target.

/// The New session's Attachments section: the same list as the Spec tab (with remove buttons) and the Attach menu
/// (Photos, Files, Paste). Its images open full screen with Annotate: the notes go on that
/// attachment, saved with the draft.
struct NewSessionAttachmentsSection: View {
    let editor: NewSessionEditor
    let ticket: Ticket
    let uploader: PromptAttachmentUploader

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    var body: some View {
        let list = ticket.promptAttachments ?? []
        let full = list.count + uploader.pending.count >= maxPromptAttachments
        Section {
            if !list.isEmpty || !uploader.pending.isEmpty {
                EditablePromptAttachmentList(
                    tiles: tiles(list),
                    pending: uploader.pending,
                    uploader: uploader,
                    onRemove: { editor.removeAttachment(at: $0.index) },
                    onAnnotate: { a, annotation in editor.annotateAttachment(a, annotation: annotation) }
                )
                .listRowBackground(c.bgElev)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }
            Menu {
                PromptAttachmentMenuItems(uploader: uploader, target: editor)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "paperclip")
                        .font(.scaled(size: 15, weight: .semibold))
                        .foregroundStyle(full ? c.text3 : c.accentText)
                        .frame(width: 18)
                    Text(list.isEmpty ? "Attach files" : "Attach more")
                        .font(.scaled(size: 15))
                        .foregroundStyle(full ? c.text3 : c.accentText)
                    Spacer(minLength: 0)
                    if !list.isEmpty {
                        Text("\(list.count) of \(maxPromptAttachments)").font(.scaled(size: 13)).foregroundStyle(c.text3)
                    }
                }
                .frame(minHeight: 36)
                .contentShape(Rectangle())
            }
            .disabled(full)
            .accessibilityLabel("Attach")
            .accessibilityValue(list.isEmpty ? "" : "\(list.count) of \(maxPromptAttachments) attached")
            .listRowBackground(c.bgElev)
        } header: {
            if !list.isEmpty || !uploader.pending.isEmpty {
                Text("Attachments")
            }
        }
    }

    /// The draft's attachments as tiles: this device's thumbnail when it has one, else the
    /// service's copy (every attachment has its id from the start).
    private func tiles(_ list: [Attachment]) -> [PromptAttachmentTile] {
        list.enumerated().map { i, a in PromptAttachmentTile(attachment: a, index: i, local: uploader.thumbnails[a.id]) }
    }
}
