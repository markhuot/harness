import HarnessKit
import SwiftUI

/// The active color theme as SwiftUI colors, read with
/// `@Environment(\.palette) private var c`. RootView resolves it from prefs and the system
/// appearance and injects it; previews get the default light theme.
struct Palette: Sendable {
    let theme: Theme
    let appearance: ThemeAppearance

    var tokens: ThemeTokens { theme.tokens }
    var isDark: Bool { appearance == .dark }

    init(_ resolved: ResolvedThemeChoice) {
        theme = resolved.theme
        appearance = resolved.appearance
        let t = resolved.theme.tokens
        bg = t.color(.bg)
        bgSidebar = t.color(.bgSidebar)
        bgElev = t.color(.bgElev)
        bgSunken = t.color(.bgSunken)
        bgColumn = t.color(.bgColumn)
        bgHover = t.color(.bgHover)
        bgActive = t.color(.bgActive)
        border = t.color(.border)
        borderStrong = t.color(.borderStrong)
        text = t.color(.text)
        text2 = t.color(.text2)
        text3 = t.color(.text3)
        accent = t.color(.accent)
        accentHover = t.color(.accentHover)
        accentSoft = t.color(.accentSoft)
        accentText = t.color(.accentText)
        onAccent = t.color(.onAccent)
        focus = t.color(.focus)
        selection = t.color(.selection)
        overlay = t.color(.overlay)
        planning = t.color(.planning)
        inProgress = t.color(.inProgress)
        blocked = t.color(.blocked)
        review = t.color(.review)
        done = t.color(.done)
        green = t.color(.green)
        greenSoft = t.color(.greenSoft)
        red = t.color(.red)
        redSoft = t.color(.redSoft)
        redSolid = t.color(.redSolid)
        onDanger = t.color(.onDanger)
        amber = t.color(.amber)
        amberSoft = t.color(.amberSoft)
        onAmber = t.color(.onAmber)
        violet = t.color(.violet)
        violetSoft = t.color(.violetSoft)
        diffAdd = t.color(.diffAdd)
        diffAddSoft = t.color(.diffAddSoft)
        diffDel = t.color(.diffDel)
        diffDelSoft = t.color(.diffDelSoft)
    }

    let bg, bgSidebar, bgElev, bgSunken, bgColumn, bgHover, bgActive: Color
    let border, borderStrong: Color
    let text, text2, text3: Color
    let accent, accentHover, accentSoft, accentText, onAccent, focus, selection, overlay: Color
    let planning, inProgress, blocked, review, done: Color
    let green, greenSoft, red, redSoft, redSolid, onDanger: Color
    let amber, amberSoft, onAmber, violet, violetSoft: Color
    let diffAdd, diffAddSoft, diffDel, diffDelSoft: Color

    /// Any token, including the shadow tokens (as their first layer's color).
    subscript(token: ThemeToken) -> Color { tokens.color(token) }

    /// A ticket status's color (`c[status]`); a status this build doesn't know is muted.
    func status(_ s: TicketStatus) -> Color {
        switch s {
        case .planning: planning
        case .inProgress: inProgress
        case .blocked: blocked
        case .review: review
        case .done: done
        case .unknown: text3
        }
    }

    /// The tone's soft fill and its ink.
    func tone(_ tone: Tone) -> (bg: Color, fg: Color) {
        switch tone {
        case .accent: (accentSoft, accentText)
        case .green: (greenSoft, green)
        case .red: (redSoft, red)
        case .amber: (amberSoft, amber)
        case .violet: (violetSoft, violet)
        case .neutral: (bgActive, text2)
        }
    }

    static let light = Palette(Themes.resolve(ThemeChoice(appearance: .light, lightTheme: Themes.defaultLightTheme, darkTheme: Themes.defaultDarkTheme), systemDark: false))
    static let dark = Palette(Themes.resolve(ThemeChoice(appearance: .dark, lightTheme: Themes.defaultLightTheme, darkTheme: Themes.defaultDarkTheme), systemDark: true))
}

/// Badge, callout and toast tones.
enum Tone: String, CaseIterable, Sendable {
    case neutral, accent, green, red, amber, violet
}

/// Claude's brand orange, for the claude-code driver badge.
let claudeOrange = Color(red: 0xd9 / 255, green: 0x77 / 255, blue: 0x57 / 255)

extension EnvironmentValues {
    @Entry var palette: Palette = .light
}

extension Font {
    /// The monospaced face used for keys, paths and tokens.
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .scaled(size: size, weight: weight, design: .monospaced)
    }

    /// The system face at `size` points at the default text size, following Dynamic Type like the
    /// body style. `Font.system(size:)` never
    /// scales; a custom font relative to a text style does, and a family that isn't installed falls
    /// back to the system face, so this keeps SF (or SF Mono) and only adds the scaling.
    static func scaled(size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        let font = Font.custom("HarnessSystemScaled", size: size, relativeTo: .body).weight(weight)
        return design == .monospaced ? font.monospaced() : font
    }
}
