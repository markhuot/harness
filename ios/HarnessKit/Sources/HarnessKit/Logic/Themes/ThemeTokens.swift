import Foundation

// Port of shared/src/themes/types.ts. Every theme fills in the same semantic tokens; they are CSS
// color strings (and box-shadow lists for the shadow tokens) exactly as the desktop uses them, so
// Color(css:) / BoxShadow.parse turn them into something SwiftUI can draw.

public enum ThemeAppearance: String, Codable, Hashable, Sendable, CaseIterable {
    case light
    case dark
}

/// A token name. `rawValue` is the TS key (`in_progress` stays snake case); `allCases` is TOKEN_KEYS order.
public enum ThemeToken: String, CodingKey, CaseIterable, Hashable, Sendable {
    case bg
    case bgSidebar
    case bgElev
    case bgSunken
    case bgColumn
    case bgHover
    case bgActive
    case border
    case borderStrong
    case text
    case text2
    case text3
    case accent
    case accentHover
    case accentSoft
    case accentText
    case onAccent
    case focus
    case selection
    case shadowSm
    case shadow
    case shadowLg
    case overlay
    case planning
    case inProgress = "in_progress"
    case blocked
    case review
    case done
    case green
    case greenSoft
    case red
    case redSoft
    case redSolid
    case onDanger
    case amber
    case amberSoft
    case onAmber
    case violet
    case violetSoft
    case diffAdd
    case diffAddSoft
    case diffDel
    case diffDelSoft

    /// Tokens that hold box-shadow lists rather than a single color (SHADOW_TOKENS).
    public static let shadowTokens: [ThemeToken] = [.shadowSm, .shadow, .shadowLg]

    public var isShadow: Bool { Self.shadowTokens.contains(self) }

    public var keyPath: WritableKeyPath<ThemeTokens, String> {
        switch self {
        case .bg: \.bg
        case .bgSidebar: \.bgSidebar
        case .bgElev: \.bgElev
        case .bgSunken: \.bgSunken
        case .bgColumn: \.bgColumn
        case .bgHover: \.bgHover
        case .bgActive: \.bgActive
        case .border: \.border
        case .borderStrong: \.borderStrong
        case .text: \.text
        case .text2: \.text2
        case .text3: \.text3
        case .accent: \.accent
        case .accentHover: \.accentHover
        case .accentSoft: \.accentSoft
        case .accentText: \.accentText
        case .onAccent: \.onAccent
        case .focus: \.focus
        case .selection: \.selection
        case .shadowSm: \.shadowSm
        case .shadow: \.shadow
        case .shadowLg: \.shadowLg
        case .overlay: \.overlay
        case .planning: \.planning
        case .inProgress: \.inProgress
        case .blocked: \.blocked
        case .review: \.review
        case .done: \.done
        case .green: \.green
        case .greenSoft: \.greenSoft
        case .red: \.red
        case .redSoft: \.redSoft
        case .redSolid: \.redSolid
        case .onDanger: \.onDanger
        case .amber: \.amber
        case .amberSoft: \.amberSoft
        case .onAmber: \.onAmber
        case .violet: \.violet
        case .violetSoft: \.violetSoft
        case .diffAdd: \.diffAdd
        case .diffAddSoft: \.diffAddSoft
        case .diffDel: \.diffDel
        case .diffDelSoft: \.diffDelSoft
        }
    }
}

/// Every token of a theme as a typed property, so views read `tokens.bgElev` directly.
public struct ThemeTokens: Codable, Hashable, Sendable {
    public var bg: String
    public var bgSidebar: String
    public var bgElev: String
    public var bgSunken: String
    public var bgColumn: String
    public var bgHover: String
    public var bgActive: String
    public var border: String
    public var borderStrong: String
    public var text: String
    public var text2: String
    public var text3: String
    public var accent: String
    public var accentHover: String
    public var accentSoft: String
    public var accentText: String
    public var onAccent: String
    public var focus: String
    public var selection: String
    public var shadowSm: String
    public var shadow: String
    public var shadowLg: String
    public var overlay: String
    public var planning: String
    public var inProgress: String
    public var blocked: String
    public var review: String
    public var done: String
    public var green: String
    public var greenSoft: String
    public var red: String
    public var redSoft: String
    public var redSolid: String
    public var onDanger: String
    public var amber: String
    public var amberSoft: String
    public var onAmber: String
    public var violet: String
    public var violetSoft: String
    public var diffAdd: String
    public var diffAddSoft: String
    public var diffDel: String
    public var diffDelSoft: String

    /// Build tokens from a value per token (every token is required).
    public init(_ value: (ThemeToken) throws -> String) rethrows {
        bg = try value(.bg)
        bgSidebar = try value(.bgSidebar)
        bgElev = try value(.bgElev)
        bgSunken = try value(.bgSunken)
        bgColumn = try value(.bgColumn)
        bgHover = try value(.bgHover)
        bgActive = try value(.bgActive)
        border = try value(.border)
        borderStrong = try value(.borderStrong)
        text = try value(.text)
        text2 = try value(.text2)
        text3 = try value(.text3)
        accent = try value(.accent)
        accentHover = try value(.accentHover)
        accentSoft = try value(.accentSoft)
        accentText = try value(.accentText)
        onAccent = try value(.onAccent)
        focus = try value(.focus)
        selection = try value(.selection)
        shadowSm = try value(.shadowSm)
        shadow = try value(.shadow)
        shadowLg = try value(.shadowLg)
        overlay = try value(.overlay)
        planning = try value(.planning)
        inProgress = try value(.inProgress)
        blocked = try value(.blocked)
        review = try value(.review)
        done = try value(.done)
        green = try value(.green)
        greenSoft = try value(.greenSoft)
        red = try value(.red)
        redSoft = try value(.redSoft)
        redSolid = try value(.redSolid)
        onDanger = try value(.onDanger)
        amber = try value(.amber)
        amberSoft = try value(.amberSoft)
        onAmber = try value(.onAmber)
        violet = try value(.violet)
        violetSoft = try value(.violetSoft)
        diffAdd = try value(.diffAdd)
        diffAddSoft = try value(.diffAddSoft)
        diffDel = try value(.diffDel)
        diffDelSoft = try value(.diffDelSoft)
    }

    public subscript(token: ThemeToken) -> String {
        get { self[keyPath: token.keyPath] }
        set { self[keyPath: token.keyPath] = newValue }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ThemeToken.self)
        try self.init { try c.decode(String.self, forKey: $0) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: ThemeToken.self)
        for t in ThemeToken.allCases { try c.encode(self[t], forKey: t) }
    }
}
