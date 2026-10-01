import HarnessKit
import SwiftUI

// Badges, pills and chips in the desktop's design language (ui/kit.tsx), sized for touch and
// capped for Dynamic Type the way the RN app caps them (maxFontSizeMultiplier ≈ 1.4).

/// A small rounded label: a tone's soft fill and ink, or outlined (`outline`) on the surface.
struct Badge: View {
    var tone: Tone = .neutral
    var outline = false
    var icon: String?
    var iconColor: Color?
    var text: String?

    init(_ text: String? = nil, tone: Tone = .neutral, outline: Bool = false, icon: String? = nil, iconColor: Color? = nil) {
        self.text = text
        self.tone = tone
        self.outline = outline
        self.icon = icon
        self.iconColor = iconColor
    }

    @Environment(\.palette) private var c

    var body: some View {
        let t = c.tone(tone)
        HStack(spacing: 4) {
            if let icon { Icon(icon, size: 11, weight: .semibold).foregroundStyle(iconColor ?? t.fg) }
            if let text {
                Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(t.fg).lineLimit(1)
            }
        }
        .padding(.horizontal, 7)
        .frame(minHeight: 21)
        .background(outline ? Color.clear : t.bg, in: .rect(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(outline ? c.border : .clear, lineWidth: 1 / 3))
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

struct StatusDot: View {
    let status: TicketStatus
    var size: CGFloat = 8
    @Environment(\.palette) private var c

    var body: some View {
        Circle().fill(c.status(status)).frame(width: size, height: size).accessibilityHidden(true)
    }
}

func statusLabel(_ s: TicketStatus) -> String { Format.statusLabel[s] ?? s.rawValue }

struct StatusPill: View {
    let status: TicketStatus
    @Environment(\.palette) private var c

    var body: some View {
        HStack(spacing: 6) {
            StatusDot(status: status)
            Text(statusLabel(status)).font(.system(size: 12.5, weight: .medium)).foregroundStyle(c.text2)
        }
        .padding(.horizontal, 9)
        .frame(height: 24)
        .background(c.bgElev, in: .capsule)
        .overlay(Capsule().strokeBorder(c.border, lineWidth: 1 / 3))
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

/// A project's key badge ("HAR") in the project's color (nil → the theme accent).
struct ProjectKeyBadge: View {
    enum Size { case sm, md, lg }
    let key_: String
    let color: String?
    var size: Size = .md

    init(_ key: String, color: String?, size: Size = .md) {
        key_ = key
        self.color = color
        self.size = size
    }

    @Environment(\.palette) private var c

    var body: some View {
        let colors = ProjectKeyColors.for(color, tokens: c.tokens)
        let (h, fs, w): (CGFloat, CGFloat, CGFloat) = switch size {
        case .sm: (16, 9, 24)
        case .md: (19, 10, 28)
        case .lg: (24, 11, 34)
        }
        Text(String(key_.prefix(3)))
            .font(.system(size: fs, weight: .bold))
            .tracking(0.3)
            .foregroundStyle(Color(css: colors.fg) ?? c.accentText)
            .padding(.horizontal, 3)
            .frame(minWidth: w, minHeight: h)
            .background(Color(css: colors.bg) ?? c.accentSoft, in: .rect(cornerRadius: 4))
            .dynamicTypeSize(...DynamicTypeSize.xLarge)
    }
}

/// Agent/human review state: approved ✓ green, changes ✕ red, skipped (outlined dash), pending ○.
struct ReviewMark: View {
    enum Who { case agent, human }
    let who: Who
    let state: ReviewState
    @Environment(\.palette) private var c

    var body: some View {
        let skipped = state == .skipped
        let tone: Tone = state == .approved ? .green : state == .changesRequested ? .red : .neutral
        let t = skipped ? (bg: Color.clear, fg: c.text3) : c.tone(tone)
        HStack(spacing: 3) {
            Icon(who == .agent ? "bot" : "user", size: 11, weight: .semibold)
            switch state {
            case .approved: Icon("check", size: 11, weight: .bold)
            case .changesRequested: Icon("x", size: 11, weight: .bold)
            case .skipped: Capsule().frame(width: 7, height: 2)
            default: Circle().strokeBorder(lineWidth: 1.5).frame(width: 6, height: 6).opacity(0.7)
            }
        }
        .foregroundStyle(t.fg)
        .padding(.horizontal, 7)
        .frame(height: 21)
        .background(t.bg, in: .rect(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(skipped ? c.border : .clear, lineWidth: 1 / 3))
        .accessibilityElement()
        .accessibilityLabel("\(who == .agent ? "Agent" : "Human") review: \(state.rawValue.replacingOccurrences(of: "_", with: " "))")
    }
}

struct DriverBadge: View {
    let driver: String
    var drivers: [DriverInfo]?

    var body: some View {
        Badge(Format.driverLabel(driver, drivers: drivers), outline: true, icon: driverIconName(driver), iconColor: driver == "claude-code" ? claudeOrange : nil)
    }
}

/// "Conductor · N" on a conductor ticket; nothing otherwise.
struct KindBadge: View {
    let ticket: Ticket
    var childCount: Int?

    var body: some View {
        if ticket.isConductor {
            Badge("Conductor\(childCount.map { $0 > 0 ? " · \($0)" : "" } ?? "")", tone: .violet, icon: "conductor")
        }
    }
}

/// The ticket's model, by its display name when the driver's model list has it.
struct ModelBadge: View {
    let model: String?
    var models: [ModelInfo]?

    var body: some View {
        if let model, !model.isEmpty {
            Badge(Models.modelName(models, model), outline: true, icon: "layers")
        }
    }
}

/// A dependency chip: done (green check), waiting (dashed, clock), or unknown (not loaded yet,
/// most likely an older done ticket: neutral, never "waiting").
struct DepChip: View {
    let label: String
    let done: Bool
    var prefix: String?
    var unknown = false
    var onTap: (() -> Void)?

    @Environment(\.palette) private var c

    var body: some View {
        let chip = HStack(spacing: 4) {
            if !unknown {
                Icon(done ? "check" : "clock", size: 9, weight: done ? .heavy : .semibold).foregroundStyle(done ? c.green : c.text2)
                if let prefix { Text(prefix).font(.system(size: 11.5)).foregroundStyle(c.text3) }
            }
            Text(label).font(.mono(11.5)).foregroundStyle(done ? c.green : c.text2)
        }
        .padding(.horizontal, 7)
        .frame(height: 21)
        .overlay(
            Capsule().strokeBorder(done ? c.greenSoft : c.borderStrong, style: StrokeStyle(lineWidth: 1, dash: done || unknown ? [] : [3, 2]))
        )
        .opacity(done ? 1 : 0.75)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        if let onTap {
            Button(action: onTap) { chip }.buttonStyle(.plain).accessibilityAddTraits(.isLink)
        } else {
            chip
        }
    }
}
