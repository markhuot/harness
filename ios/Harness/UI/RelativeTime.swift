import HarnessKit
import SwiftUI

/// How often a relative timestamp refreshes: the default 30 s, 10 s
/// for approvals, 1 s while something is running.
enum NowInterval: Double, Sendable {
    case standard = 30
    case approval = 10
    case live = 1
}

extension EnvironmentValues {
    /// A fixed current time (epoch ms) in place of the clock, so the snapshot tests' relative
    /// timestamps never change between runs. nil in the app.
    @Entry var snapshotNow: Double?
}

/// "42s ago" (Format.relativeTime) that keeps itself current with a TimelineView.
struct RelativeTimeText: View {
    @Environment(\.snapshotNow) private var fixedNow
    /// Epoch milliseconds; nil or 0 reads "never".
    let ms: Double?
    var interval: NowInterval = .standard
    var format: (String) -> String = { $0 }

    var body: some View {
        TimelineView(.periodic(from: .now, by: interval.rawValue)) { ctx in
            Text(format(Format.relativeTime(ms, now: fixedNow ?? ctx.date.timeIntervalSince1970 * 1000)))
        }
    }
}

/// The current time in ms, refreshed every `interval`, for views that compute more than a label.
struct NowReader<Content: View>: View {
    @Environment(\.snapshotNow) private var fixedNow
    var interval: NowInterval = .standard
    @ViewBuilder var content: (Double) -> Content

    var body: some View {
        TimelineView(.periodic(from: .now, by: interval.rawValue)) { ctx in
            content(fixedNow ?? ctx.date.timeIntervalSince1970 * 1000)
        }
    }
}
