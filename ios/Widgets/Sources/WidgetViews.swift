import HarnessKit
import SwiftUI
import WidgetKit

// The widget's sizes. Cards (the default): small is the most recent active ticket, medium the same
// ticket with room for its blocked reason or latest Activity line, large the first three as board
// cards. Compact (the Compact setting) is a list in every size, one ticket per line: status,
// project pill, key, title.

struct ActiveTicketsView: View {
    let entry: ActiveTicketsEntry

    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let theme = WidgetTheme(host: entry.load.host, dark: scheme == .dark)
        content
            .environment(\.widgetTheme, theme)
            .containerBackground(for: .widget) { theme.color(\.bg) }
            .widgetURL(WidgetFeed.boardURL)
    }

    @ViewBuilder private var content: some View {
        let tickets = entry.load.snapshot.tickets
        if case .unpaired = entry.load.source, tickets.isEmpty {
            WidgetMessage(icon: "link", title: "Not paired", detail: "Open Harness and connect to your Mac.")
        } else if tickets.isEmpty {
            WidgetMessage(icon: "checkmark.circle", title: "Nothing active", detail: "No agent is working on a ticket right now.")
                .overlay(alignment: .bottom) { WidgetFooter(load: entry.load, shown: 0) }
        } else if entry.compact {
            CompactList(load: entry.load, rows: compactRows)
        } else {
            switch family {
            case .systemSmall: SmallCard(ticket: tickets[0], load: entry.load)
            case .systemMedium: MediumCard(ticket: tickets[0], load: entry.load)
            default: LargeBoard(load: entry.load)
            }
        }
    }

    /// Lines the compact list has room for under its header.
    private var compactRows: Int {
        switch family {
        case .systemSmall: 4
        case .systemMedium: 4
        default: 10
        }
    }
}

// MARK: Theme

/// The app's theme tokens as colors: the theme the app last wrote with the host (or the default),
/// for the widget's light or dark appearance.
struct WidgetTheme {
    let tokens: ThemeTokens

    init(host: WidgetHost?, dark: Bool) {
        let appearance: ThemeAppearance = dark ? .dark : .light
        let id = Themes.themeId(for: appearance, dark ? host?.darkTheme : host?.lightTheme)
        tokens = (Themes.find(id) ?? Themes.themes(for: appearance)[0]).tokens
    }

    func color(_ token: KeyPath<ThemeTokens, String>) -> Color { Color(widgetCSS: tokens[keyPath: token]) ?? .clear }

    func status(_ s: TicketStatus) -> Color {
        switch s {
        case .planning: color(\.planning)
        case .inProgress: color(\.inProgress)
        case .blocked: color(\.blocked)
        case .review: color(\.review)
        case .done: color(\.done)
        case .unknown: color(\.text3)
        }
    }

    func project(_ color: String?) -> (fg: Color, bg: Color) {
        let c = ProjectKeyColors.for(color, tokens: tokens)
        return (Color(widgetCSS: c.fg) ?? self.color(\.accentText), Color(widgetCSS: c.bg) ?? self.color(\.accentSoft))
    }
}

private struct WidgetThemeKey: EnvironmentKey {
    static let defaultValue = WidgetTheme(host: nil, dark: false)
}

extension EnvironmentValues {
    var widgetTheme: WidgetTheme {
        get { self[WidgetThemeKey.self] }
        set { self[WidgetThemeKey.self] = newValue }
    }
}

extension Color {
    /// A CSS color from a theme token; nil when HarnessKit's parser rejects it.
    init?(widgetCSS css: String) {
        guard let c = RGBA(css: css) else { return nil }
        func unit(_ v: Double, _ scale: Double) -> Double { v.isNaN ? 0 : min(1, max(0, v / scale)) }
        self.init(.sRGB, red: unit(c.r, 255), green: unit(c.g, 255), blue: unit(c.b, 255), opacity: unit(c.a, 1))
    }
}

// MARK: Pieces

/// What a ticket's status looks like: an SF Symbol and its label. A pending approval and a running
/// agent get their own symbols.
enum StatusLook {
    static func symbol(_ t: WidgetTicket) -> String {
        if t.approvalTool != nil { return "lock.circle.fill" }
        switch t.status {
        case .planning: return t.working ? "pencil.circle.fill" : "circle.dashed"
        case .inProgress: return t.working ? "bolt.circle.fill" : "play.circle.fill"
        case .blocked: return "exclamationmark.circle.fill"
        case .review: return "eye.circle.fill"
        case .done: return "checkmark.circle.fill"
        case .unknown: return "circle"
        }
    }

    static func label(_ t: WidgetTicket) -> String {
        if t.approvalTool != nil { return "Needs approval" }
        if t.working, t.status == .inProgress { return "Working" }
        return Format.statusLabel[t.status] ?? t.status.rawValue
    }
}

struct StatusIcon: View {
    let ticket: WidgetTicket
    var size: CGFloat = 13
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        Image(systemName: StatusLook.symbol(ticket))
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(theme.status(ticket.status))
            .widgetAccentable()
            .accessibilityLabel(StatusLook.label(ticket))
    }
}

/// The status as a tinted chip: icon and label.
struct StatusChip: View {
    let ticket: WidgetTicket
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        let tint = theme.status(ticket.status)
        HStack(spacing: 3) {
            Image(systemName: StatusLook.symbol(ticket)).font(.system(size: 10, weight: .bold))
            Text(StatusLook.label(ticket)).font(.system(size: 10, weight: .semibold)).lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 6)
        .frame(height: 18)
        .background(tint.opacity(0.14), in: .capsule)
        .widgetAccentable()
        .fixedSize()
    }
}

/// The project pill: its key's first three letters on the project's color, as on board cards.
struct ProjectPill: View {
    let ticket: WidgetTicket
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        if let key = ticket.projectKey {
            let colors = theme.project(ticket.projectColor)
            Text(String(key.prefix(3)))
                .font(.system(size: 9, weight: .bold))
                .tracking(0.3)
                .foregroundStyle(colors.fg)
                .padding(.horizontal, 3)
                .frame(minWidth: 24, minHeight: 16)
                .background(colors.bg, in: .rect(cornerRadius: 4))
                .fixedSize()
        }
    }
}

struct TicketKey: View {
    let ticket: WidgetTicket
    var size: CGFloat = 11
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        Text(ticket.displayKey)
            .font(.system(size: size, weight: .medium, design: .monospaced))
            .foregroundStyle(theme.color(\.text2))
            .lineLimit(1)
            .fixedSize()
    }
}

/// The approval request or blocked reason, as the board card's tinted note.
struct TicketNote: View {
    let ticket: WidgetTicket
    var lines = 2
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        if let tool = ticket.approvalTool {
            note(icon: "lock.fill", fg: theme.color(\.amber), bg: theme.color(\.amberSoft), text: "Needs approval: \(tool)")
        } else if let reason = ticket.blockedReason {
            note(icon: "exclamationmark.triangle.fill", fg: theme.color(\.red), bg: theme.color(\.redSoft), text: reason)
        } else if let news = ticket.news {
            Text(news)
                .font(.system(size: 12))
                .foregroundStyle(theme.color(\.text2))
                .lineLimit(lines)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func note(icon: String, fg: Color, bg: Color, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: icon).font(.system(size: 10, weight: .semibold))
            Text(text).font(.system(size: 12)).lineLimit(lines)
        }
        .foregroundStyle(fg)
        .padding(.vertical, 5)
        .padding(.horizontal, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(bg, in: .rect(cornerRadius: 7))
    }
}

/// "+2 more" and, when the service couldn't be reached, when the shown tickets are from.
struct WidgetFooter: View {
    let load: WidgetLoad
    let shown: Int
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        let more = load.snapshot.activeCount - shown
        HStack(spacing: 4) {
            if case .saved = load.source {
                Image(systemName: "wifi.slash").font(.system(size: 9, weight: .semibold))
                if load.snapshot.generatedAt > 0 {
                    Text(Date(timeIntervalSince1970: load.snapshot.generatedAt / 1000), style: .relative) + Text(" ago")
                } else {
                    Text("Offline")
                }
            }
            Spacer(minLength: 0)
            if more > 0 { Text("+\(more) more") }
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(theme.color(\.text3))
        .lineLimit(1)
    }
}

struct WidgetMessage: View {
    let icon: String
    let title: String
    let detail: String
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 22, weight: .semibold)).foregroundStyle(theme.color(\.accent)).widgetAccentable()
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.color(\.text))
            Text(detail).font(.system(size: 11)).foregroundStyle(theme.color(\.text2)).multilineTextAlignment(.center).lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: Cards

/// Small: the most recent active ticket.
struct SmallCard: View {
    let ticket: WidgetTicket
    let load: WidgetLoad
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                ProjectPill(ticket: ticket)
                TicketKey(ticket: ticket).layoutPriority(-1)
                Spacer(minLength: 0)
                StatusIcon(ticket: ticket, size: 15)
            }
            Text(ticket.title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(theme.color(\.text))
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
            Text(StatusLook.label(ticket))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(theme.status(ticket.status))
                .widgetAccentable()
            WidgetFooter(load: load, shown: 1)
        }
        .widgetURL(WidgetFeed.ticketURL(ticket.key))
    }
}

/// Medium: the most recent active ticket, with its note or latest Activity line.
struct MediumCard: View {
    let ticket: WidgetTicket
    let load: WidgetLoad
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                ProjectPill(ticket: ticket)
                TicketKey(ticket: ticket, size: 12).layoutPriority(-1)
                Spacer(minLength: 0)
                StatusChip(ticket: ticket)
            }
            Text(ticket.title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(theme.color(\.text))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            TicketNote(ticket: ticket, lines: 2)
            Spacer(minLength: 0)
            WidgetFooter(load: load, shown: 1)
        }
        .widgetURL(WidgetFeed.ticketURL(ticket.key))
    }
}

/// Large: up to three of the most recent active tickets as board cards.
struct LargeBoard: View {
    let load: WidgetLoad
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        let tickets = Array(load.snapshot.tickets.prefix(3))
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(count: load.snapshot.activeCount)
            ForEach(tickets) { t in
                Link(destination: WidgetFeed.ticketURL(t.key) ?? WidgetFeed.boardURL) { BoardCard(ticket: t) }
            }
            Spacer(minLength: 0)
            WidgetFooter(load: load, shown: tickets.count)
        }
    }
}

/// One ticket as the board draws it: pill, key and status, the title, then its note.
struct BoardCard: View {
    let ticket: WidgetTicket
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                ProjectPill(ticket: ticket)
                TicketKey(ticket: ticket).layoutPriority(-1)
                Spacer(minLength: 0)
                StatusChip(ticket: ticket)
            }
            Text(ticket.title)
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(theme.color(\.text))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            TicketNote(ticket: ticket, lines: 1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(theme.color(\.bgElev), in: .rect(cornerRadius: 10))
        .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(theme.color(\.border), lineWidth: 0.5) }
    }
}

struct WidgetHeader: View {
    let count: Int
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        HStack(spacing: 5) {
            Text("Active").font(.system(size: 12, weight: .bold)).foregroundStyle(theme.color(\.text))
            Text("\(count)").font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.color(\.text3))
            Spacer(minLength: 0)
        }
    }
}

// MARK: Compact

/// Compact, in any size: one ticket per line (status, project pill, key, title).
struct CompactList: View {
    let load: WidgetLoad
    let rows: Int

    var body: some View {
        let tickets = Array(load.snapshot.tickets.prefix(rows))
        VStack(alignment: .leading, spacing: 0) {
            WidgetHeader(count: load.snapshot.activeCount).padding(.bottom, 4)
            ForEach(tickets) { t in
                Link(destination: WidgetFeed.ticketURL(t.key) ?? WidgetFeed.boardURL) { CompactRow(ticket: t) }
                    .frame(maxHeight: 26)
            }
            Spacer(minLength: 0)
            WidgetFooter(load: load, shown: tickets.count)
        }
    }
}

struct CompactRow: View {
    let ticket: WidgetTicket
    @Environment(\.widgetTheme) private var theme

    var body: some View {
        // Narrow widgets drop the pill before the title gets too short to read.
        ViewThatFits(in: .horizontal) {
            row(pill: true)
            row(pill: false)
        }
    }

    private func row(pill: Bool) -> some View {
        HStack(spacing: 5) {
            StatusIcon(ticket: ticket, size: 12)
            if pill { ProjectPill(ticket: ticket) }
            TicketKey(ticket: ticket, size: 10.5)
            Text(ticket.title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(theme.color(\.text))
                .lineLimit(1)
                .frame(minWidth: 44, maxWidth: .infinity, alignment: .leading)
        }
    }
}
