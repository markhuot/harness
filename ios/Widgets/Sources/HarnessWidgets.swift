import AppIntents
import HarnessKit
import SwiftUI
import WidgetKit

// The widget extension: the same sources build the iPhone/iPad extension (HarnessWidgets, embedded
// in the app) and the Mac one (HarnessMacWidgets, embedded in the Electron app by
// app/scripts/package.ts). ARCHITECTURE.md § Widgets.

@main
struct HarnessWidgetBundle: WidgetBundle {
    var body: some Widget {
        ActiveTicketsWidget()
    }
}

/// The widget's settings (Edit Widget): Compact lists tickets one per line instead of as cards.
struct ActiveTicketsIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Active tickets"
    static let description = IntentDescription("The tickets your agents are working on, most recent first.")

    @Parameter(title: "Compact", description: "List tickets one per line instead of as cards.", default: false)
    var compact: Bool

    init() {}

    init(compact: Bool) {
        self.compact = compact
    }
}

struct ActiveTicketsEntry: TimelineEntry {
    let date: Date
    let load: WidgetLoad
    let compact: Bool
}

struct ActiveTicketsProvider: AppIntentTimelineProvider {
    /// How often a widget asks the service again on its own. The apps also reload it whenever the
    /// board changes while they run.
    static let refresh: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> ActiveTicketsEntry {
        ActiveTicketsEntry(date: .now, load: WidgetLoad(snapshot: WidgetSamples.snapshot, source: .live, host: nil), compact: false)
    }

    func snapshot(for configuration: ActiveTicketsIntent, in context: Context) async -> ActiveTicketsEntry {
        // The gallery previews with sample tickets, so it never waits on the network.
        if context.isPreview {
            return ActiveTicketsEntry(date: .now, load: WidgetLoad(snapshot: WidgetSamples.snapshot, source: .live, host: nil), compact: configuration.compact)
        }
        return await entry(configuration)
    }

    func timeline(for configuration: ActiveTicketsIntent, in context: Context) async -> Timeline<ActiveTicketsEntry> {
        let entry = await entry(configuration)
        return Timeline(entries: [entry], policy: .after(entry.date.addingTimeInterval(Self.refresh)))
    }

    private func entry(_ configuration: ActiveTicketsIntent) async -> ActiveTicketsEntry {
        let now = Date.now
        let load = await WidgetLoad.load(WidgetShared.appGroup(), now: now.timeIntervalSince1970 * 1000)
        return ActiveTicketsEntry(date: now, load: load, compact: configuration.compact)
    }
}

struct ActiveTicketsWidget: Widget {
    static let kind = "ActiveTickets"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: ActiveTicketsIntent.self, provider: ActiveTicketsProvider()) { entry in
            ActiveTicketsView(entry: entry)
        }
        .configurationDisplayName("Active tickets")
        .description("The tickets your agents are working on, most recent first.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

/// Sample tickets for the widget gallery and the placeholder.
enum WidgetSamples {
    static let snapshot = WidgetSnapshot(
        tickets: [
            WidgetTicket(
                key: "WEB-12", displayKey: "WEB-12", title: "Add dark mode to the settings screen", status: .inProgress, projectKey: "WEB",
                projectColor: "blue", working: true, news: "Wired the toggle to the theme store; tests pass", updatedAt: 0
            ),
            WidgetTicket(
                key: "API-7", displayKey: "API-7", title: "Retry failed uploads with backoff", status: .blocked, projectKey: "API",
                projectColor: "orange", blockedReason: "Should retries stop after 5 attempts or 10 minutes?", updatedAt: 0
            ),
            WidgetTicket(
                key: "WEB-9", displayKey: "WEB-9", title: "Fix the flaky checkout test", status: .review, projectKey: "WEB",
                projectColor: "blue", news: "Waited on the network idle state instead of a sleep", updatedAt: 0
            ),
        ],
        activeCount: 3, generatedAt: 0
    )
}
