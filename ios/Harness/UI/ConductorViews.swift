import HarnessKit
import SwiftUI

// Conductor presentation shared by the board and ticket detail: the segmented
// progress bar, the rollup on a conductor's card and the "Part of" breadcrumb on a child.

struct ProgressBar: View {
    let progress: Conductor.Progress
    var height: CGFloat = 6
    @Environment(\.palette) private var c

    var body: some View {
        GeometryReader { geo in
            let segments = Conductor.progressSegments(progress)
            let gaps = CGFloat(max(0, segments.count - 1)) * 1.5
            HStack(spacing: 1.5) {
                ForEach(segments, id: \.status) { s in
                    Rectangle()
                        .fill(c.status(s.status))
                        .opacity(s.status == .planning ? 0.45 : 1)
                        .frame(width: max(2, (geo.size.width - gaps) * s.pct / 100))
                }
                Spacer(minLength: 0)
            }
        }
        .frame(height: height)
        .background(c.bgActive)
        .clipShape(.capsule)
        .accessibilityElement()
        .accessibilityLabel(Conductor.progressLabel(progress))
    }
}

/// "3/7 done" with the bar, and "2 need you" when children are waiting on a human.
struct ConductorRollup: View {
    let progress: Conductor.Progress
    @Environment(\.palette) private var c

    var body: some View {
        if progress.total > 0 {
            HStack(spacing: 8) {
                ProgressBar(progress: progress, height: 4)
                Text("\(progress.count(.done))/\(progress.total) done")
                    .font(.scaled(size: 12, weight: .medium)).monospacedDigit().foregroundStyle(c.text2)
                if progress.attention > 0 {
                    HStack(spacing: 3) {
                        Icon("alert", size: 10, weight: .semibold)
                        Text("\(progress.attention) need\(progress.attention == 1 ? "s" : "") you").font(.scaled(size: 11.5, weight: .semibold))
                    }
                    .foregroundStyle(c.red)
                    .padding(.horizontal, 7)
                    .frame(height: 19)
                    .background(c.redSoft, in: .capsule)
                }
            }
        }
    }
}

/// Progress across a ticket's children in the ticket hero: the label, how many wait on you, and
/// the bar. Taps open the Tickets tab, where each child has its detail. `loading` while the
/// done children are still paging in.
struct ConductorProgressCard: View {
    let progress: Conductor.Progress
    var loading = false
    let onOpen: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        if progress.total > 0 {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Text(Conductor.progressLabel(progress)).font(.scaled(size: 14, weight: .medium)).monospacedDigit().foregroundStyle(c.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if loading { Spinner() }
                        Icon("chevronRight", size: 13).foregroundStyle(c.text3)
                    }
                    ProgressBar(progress: progress)
                    if progress.attention > 0 {
                        HStack(spacing: 5) {
                            Icon("alert", size: 12, weight: .semibold)
                            Text(TicketDetailLogic.waitingOnYou(progress.attention)).font(.scaled(size: 13))
                        }
                        .foregroundStyle(c.red)
                    }
                }
                .padding(12)
                .background(c.bgElev, in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 1 / 3))
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(progress.attention > 0
                ? "\(Conductor.progressLabel(progress)), \(TicketDetailLogic.waitingOnYou(progress.attention))"
                : Conductor.progressLabel(progress))
            .accessibilityHint("Shows the tickets")
            .accessibilityAddTraits(.isButton)
        }
    }
}

/// "Part of HAR-12 Ship the thing ›" on a child ticket.
struct ParentCrumb: View {
    let parent: Ticket
    let onOpen: (String) -> Void
    @Environment(\.palette) private var c

    var body: some View {
        Button { onOpen(parent.key) } label: {
            HStack(spacing: 6) {
                Icon("conductor", size: 12).foregroundStyle(c.violet)
                Text("Part of").foregroundStyle(c.text3)
                Text(Keys.keyLabel(parent)).font(.mono(13)).foregroundStyle(c.text2)
                Text(parent.title.isEmpty ? "Untitled" : parent.title).foregroundStyle(c.text2).lineLimit(1)
                Icon("chevronRight", size: 12).foregroundStyle(c.text3)
            }
            .font(.scaled(size: 13))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isLink)
        .accessibilityLabel("Part of \(Keys.keyLabel(parent))")
    }
}
