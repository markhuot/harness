import HarnessKit
import SwiftUI

/// The plan-usage gauges at the bottom of the sidebar, above Settings: one compact bar per usage
/// window a driver reports (Claude's 5-hour and weekly limits, Copilot's premium requests), in
/// "Used so far" or "Projected at reset". The driver filter and the mode are per-device prefs.
/// Nothing shows until a driver reports plan usage.
struct PlanUsageSection: View {
    let report: PlanUsageReport?

    @AppStorage("planUsageFilter") private var filterStorage = PlanUsageFilter.all.storage
    @AppStorage("planUsageMode") private var modeStorage = PlanUsageMode.usedSoFar.rawValue
    @State private var showingInfo = false
    @Environment(\.palette) private var c

    private var filter: PlanUsageFilter { PlanUsageFilter(storage: filterStorage) }
    private var mode: PlanUsageMode { PlanUsageMode(rawValue: modeStorage) ?? .usedSoFar }

    var body: some View {
        if let report, !report.drivers.isEmpty {
            // Re-render each minute so projected bars and reset times move between polls.
            TimelineView(.everyMinute) { context in
                let now = context.date.timeIntervalSince1970 * 1000
                let rows = PlanUsage.rows(report, filter: filter, mode: mode, now: now)
                VStack(alignment: .leading, spacing: 8) {
                    header(report)
                    if filter != .hide {
                        if rows.isEmpty {
                            Text(emptyText(report))
                                .font(.scaled(size: 13)).foregroundStyle(c.text3)
                                .padding(.horizontal, 4)
                        } else {
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(rows) { row in
                                    switch row {
                                    case let .gauge(g): PlanGaugeRow(gauge: g, showDriver: showDriver(report))
                                    case let .note(n): PlanNoteRow(note: n)
                                    }
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(c.bgSunken, in: .rect(cornerRadius: 12))
                        }
                    }
                }
            }
            .accessibilityIdentifier("planUsage")
        }
    }

    /// The driver's name leads a row only when more than one driver's rows show.
    private func showDriver(_ report: PlanUsageReport) -> Bool {
        filter == .all && report.drivers.count > 1
    }

    private func emptyText(_ report: PlanUsageReport) -> String {
        if case let .driver(id) = filter {
            return "No plan usage for \(id == "" ? "this driver" : id)"
        }
        return "No plan usage to show"
    }

    private func header(_ report: PlanUsageReport) -> some View {
        HStack(spacing: 6) {
            SectionTitle("Plan usage")
            Button { showingInfo = true } label: {
                Image(systemName: "info.circle").font(.system(size: 14)).foregroundStyle(c.text3).frame(width: 28, height: 28)
            }
            .accessibilityLabel("About plan usage")
            .popover(isPresented: $showingInfo) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(PlanUsage.infoText)
                    Text(PlanUsage.projectedInfoText)
                }
                .font(.scaled(size: 14))
                .padding(16)
                .frame(maxWidth: 320, alignment: .leading)
                .presentationCompactAdaptation(.popover)
            }
            Spacer()
            Menu {
                Picker("Show", selection: $filterStorage) {
                    Text("All drivers").tag(PlanUsageFilter.all.storage)
                    ForEach(PlanUsage.drivers(report), id: \.id) { d in
                        Text(d.name).tag(PlanUsageFilter.driver(d.id).storage)
                    }
                    Text("Hide").tag(PlanUsageFilter.hide.storage)
                }
                Picker("Display", selection: $modeStorage) {
                    ForEach(PlanUsageMode.allCases, id: \.rawValue) { m in
                        Text(m.title).tag(m.rawValue)
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(filter == .hide ? "Hidden" : mode.title).font(.scaled(size: 12))
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold))
                }
                .foregroundStyle(c.text3)
                .frame(minHeight: 28)
                .contentShape(.rect)
            }
            .accessibilityLabel("Plan usage options")
        }
        .padding(.horizontal, 4)
    }
}

private extension PlanUsageBand {
    func color(_ c: Palette) -> Color {
        switch self {
        case .neutral: c.text3
        case .green: c.green
        case .amber: c.amber
        case .red: c.red
        }
    }
}

/// A label with its bar, percent or pace text and reset time.
private struct PlanGaugeRow: View {
    let gauge: PlanGauge
    var showDriver = false
    @Environment(\.palette) private var c

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(showDriver ? "\(gauge.driverName) · \(gauge.label)" : gauge.label)
                    .font(.scaled(size: 13, weight: .medium)).foregroundStyle(c.text).lineLimit(1)
                Spacer(minLength: 4)
                Text(gauge.valueText).font(.scaled(size: 12)).monospacedDigit().foregroundStyle(gauge.band == .neutral ? c.text2 : gauge.band.color(c)).lineLimit(1)
            }
            PlanGaugeBar(fill: gauge.fill, tick: gauge.tick, tint: gauge.band == .neutral ? c.accent : gauge.band.color(c))
            Text(gauge.resetText).font(.scaled(size: 11)).foregroundStyle(c.text3).lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(gauge.accessibilityLabel)
        .accessibilityIdentifier("planUsage.\(gauge.id)")
    }
}

/// A driver whose usage can't be read (the reason), or whose state is all the CLI reports.
private struct PlanNoteRow: View {
    let note: PlanNote
    @Environment(\.palette) private var c

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(note.driverName).font(.scaled(size: 13, weight: .medium)).foregroundStyle(c.text)
            Text(note.text).font(.scaled(size: 12)).foregroundStyle(note.band == .neutral ? c.text3 : note.band.color(c))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(note.accessibilityLabel)
        .accessibilityIdentifier("planUsage.\(note.id)")
    }
}

/// A thin horizontal bar, with an optional tick where "exactly 100% by the reset" sits.
struct PlanGaugeBar: View {
    let fill: Double
    var tick = false
    let tint: Color
    @Environment(\.palette) private var c

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(c.border)
                Capsule().fill(tint).frame(width: max(geo.size.width * fill, fill > 0 ? 4 : 0))
                if tick {
                    Rectangle().fill(c.text2)
                        .frame(width: 1.5, height: 10)
                        .offset(x: geo.size.width * PlanUsage.tickPosition - 0.75)
                }
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: 10)
        .accessibilityHidden(true)
    }
}
