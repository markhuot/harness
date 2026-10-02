import HarnessKit
import SwiftUI

/// A ticket's identifier as the board shows it (ui/TicketKey.tsx, DESIGN.md "Remote IDs"): its
/// remote ID when linked, with the local key after it, muted and smaller ("MH-62 · MH-124"). An
/// unlinked ticket shows its key alone. Only a label: routes and copy-key use the local key.
struct TicketKeyLabel: View {
    let ticket: any TicketKeyed
    var size: CGFloat = 12.5
    var color: Color?
    var lineLimit = 1

    @Environment(\.palette) private var c

    var body: some View {
        let local = Keys.secondaryKey(ticket)
        let head = Text(Keys.displayKey(ticket)).font(.mono(size)).foregroundStyle(color ?? (local != nil ? c.text2 : c.text3))
        let tail = Text(local.map { " · \($0)" } ?? "").font(.mono(size - 1.5)).foregroundStyle(c.text3)
        return Text("\(head)\(tail)").lineLimit(lineLimit)
    }
}

/// The tickets that share a remote ID (ui/RelatedTickets.tsx), as rows that open each one.
struct RelatedTicketRows: View {
    let related: [RelatedTicket]
    let onOpen: (String) -> Void
    var dividerFirst = false

    @Environment(\.palette) private var c

    var body: some View {
        ForEach(Array(related.enumerated()), id: \.element.key) { i, r in
            VStack(spacing: 0) {
                if i > 0 || dividerFirst { Divider().overlay(c.border) }
                Button { onOpen(r.key) } label: {
                    HStack(spacing: 9) {
                        StatusDot(status: r.status)
                        VStack(alignment: .leading, spacing: 1) {
                            TicketKeyLabel(ticket: r)
                            Text(r.title.isEmpty ? "Untitled" : r.title).font(.scaled(size: 14.5)).foregroundStyle(c.text).lineLimit(2)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Icon("chevronRight", size: 12).foregroundStyle(c.text3)
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 10)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityAddTraits(.isLink)
                .accessibilityLabel("\(Related.relatedLabel(r)) \(r.title.isEmpty ? "Untitled" : r.title), \(statusLabel(r.status))")
            }
        }
    }
}
