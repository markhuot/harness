import Foundation
import Testing
@testable import HarnessKit

struct ThemeIdForInput: Decodable, Sendable { let appearance: ThemeAppearance; let id: JSONValue }
struct ResolveInput: Decodable, Sendable { let choice: ThemeChoice; let systemDark: Bool }
struct ResolveOutput: Decodable, Sendable, Equatable { let appearance: ThemeAppearance; let themeId: String }
struct SyntaxInput: Decodable, Sendable { let appearance: ThemeAppearance; let syntaxTheme: String?; let failed: [String] }
struct ViewerInput: Decodable, Sendable { let appearance: ThemeAppearance; let name: String }
struct KeyColorsInput: Decodable, Sendable { let color: String?; let themeId: String }

struct ShadowOutput: Decodable, Sendable, Equatable {
    let x: Double
    let y: Double
    let blur: Double
    let spread: Double
    let color: RGBAOutput?
    let inset: Bool

    init(x: Double, y: Double, blur: Double, spread: Double, color: RGBAOutput?, inset: Bool) {
        self.x = x
        self.y = y
        self.blur = blur
        self.spread = spread
        self.color = color
        self.inset = inset
    }

    init(_ s: BoxShadow) {
        self.init(x: s.x, y: s.y, blur: s.blur, spread: s.spread, color: s.color.map(RGBAOutput.init), inset: s.inset)
    }
}

@Suite("themes/index.ts, syntax.ts, projectColor.ts parity")
struct ThemesTests {
    // MARK: Registry

    @Test func tokenOrderMatchesTokenKeys() throws {
        let keys = try Fixture.value("themes", "tokenKeys", as: [String].self)
        #expect(ThemeToken.allCases.map(\.rawValue) == keys)
        let shadows = try Fixture.value("themes", "shadowTokens", as: [String].self)
        #expect(ThemeToken.shadowTokens.map(\.rawValue) == shadows)
        #expect(ThemeToken.allCases.filter(\.isShadow) == ThemeToken.shadowTokens)
    }

    @Test func registryIsInPickerOrder() throws {
        let byAppearance = Fixture.cases("themes", "themesForCases", input: ThemeAppearance.self, output: [String].self)
        let light = try #require(byAppearance.first { $0.input == .light }).output
        let dark = try #require(byAppearance.first { $0.input == .dark }).output
        #expect(Themes.all.map(\.id) == light + dark)
        #expect(Set(Themes.all.map(\.id)).count == Themes.all.count)
        #expect(Themes.find(Themes.defaultLightTheme)?.appearance == .light)
        #expect(Themes.find(Themes.defaultDarkTheme)?.appearance == .dark)
    }

    /// Every bundled theme decodes, and every token is something the app can draw.
    @Test(arguments: Themes.all)
    func everyTokenParses(_ theme: Theme) throws {
        #expect(!theme.name.isEmpty && !theme.source.isEmpty)
        for token in ThemeToken.allCases {
            let value = theme.tokens[token]
            if token.isShadow {
                let layers = try #require(BoxShadow.parseList(value), "\(theme.id).\(token.rawValue) = \(value)")
                #expect(!layers.isEmpty && layers.allSatisfy { $0.color != nil })
            } else {
                let c = try #require(RGBA(css: value), "\(theme.id).\(token.rawValue) = \(value)")
                #expect((0...255).contains(c.r) && (0...255).contains(c.g) && (0...255).contains(c.b) && (0...1).contains(c.a))
            }
        }
    }

    @Test func themeRoundTripsWithNullSyntaxTheme() throws {
        let theme = try #require(Themes.all.first { $0.syntaxTheme == nil })
        let data = try JSONEncoder().encode(theme)
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["syntaxTheme"] is NSNull)
        #expect(try JSONDecoder().decode(Theme.self, from: data) == theme)
    }

    @Test func missingTokenFailsToDecode() throws {
        var json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(Themes.all[0])) as? [String: Any])
        var tokens = try #require(json["tokens"] as? [String: Any])
        tokens["in_progress"] = nil
        json["tokens"] = tokens
        let data = try JSONSerialization.data(withJSONObject: json)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(Theme.self, from: data) }
    }

    @Test func iconsCoverEveryName() {
        #expect(!Icons.names.isEmpty)
        #expect(Set(Icons.names) == Set(Icons.paths.keys))
        #expect(Icons.names.count == Icons.paths.count)
        #expect(Icons.isIconName("plus") && !Icons.isIconName("nope"))
    }

    // MARK: index.ts

    @Test(arguments: Fixture.cases("themes", "findThemeCases", input: JSONValue.self, output: String?.self))
    func findTheme(_ c: Fixture.Case<JSONValue, String?>) {
        #expect(Themes.find(c.input)?.id == c.output)
    }

    @Test(arguments: Fixture.cases("themes", "themesForCases", input: ThemeAppearance.self, output: [String].self))
    func themesFor(_ c: Fixture.Case<ThemeAppearance, [String]>) {
        #expect(Themes.themes(for: c.input).map(\.id) == c.output)
    }

    @Test(arguments: Fixture.cases("themes", "themeIdForCases", input: ThemeIdForInput.self, output: String.self))
    func themeIdFor(_ c: Fixture.Case<ThemeIdForInput, String>) {
        #expect(Themes.themeId(for: c.input.appearance, c.input.id) == c.output)
    }

    @Test(arguments: Fixture.cases("themes", "isAppearancePreferenceCases", input: JSONValue.self, output: Bool.self))
    func isAppearancePreference(_ c: Fixture.Case<JSONValue, Bool>) {
        #expect(Themes.isAppearancePreference(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("themes", "normalizeThemeChoiceCases", input: JSONValue.self, output: ThemeChoice.self))
    func normalizeThemeChoice(_ c: Fixture.Case<JSONValue, ThemeChoice>) {
        #expect(Themes.normalizeThemeChoice(c.input) == c.output)
        if case let .object(o) = c.input, o.values.allSatisfy({ $0.stringValue != nil }) {
            let typed = Themes.normalizeThemeChoice(appearance: o["appearance"]?.stringValue, lightTheme: o["lightTheme"]?.stringValue, darkTheme: o["darkTheme"]?.stringValue)
            #expect(typed == c.output)
        }
    }

    @Test(arguments: Fixture.cases("themes", "resolveThemeChoiceCases", input: ResolveInput.self, output: ResolveOutput.self))
    func resolveThemeChoice(_ c: Fixture.Case<ResolveInput, ResolveOutput>) {
        let r = Themes.resolve(c.input.choice, systemDark: c.input.systemDark)
        #expect(ResolveOutput(appearance: r.appearance, themeId: r.theme.id) == c.output)
        #expect(r.theme.appearance == r.appearance)
    }

    @Test(arguments: Fixture.cases("themes", "pluginThemeInfoCases", input: String.self, output: JSONValue.self))
    func pluginThemeInfo(_ c: Fixture.Case<String, JSONValue>) throws {
        let theme = try #require(Themes.find(c.input))
        let got = try JSONEncoder().encode(theme.pluginInfo)
        #expect(try jsonEqual(got, JSONEncoder().encode(c.output)))
        #expect(try JSONDecoder().decode(PluginThemeInfo.self, from: got) == theme.pluginInfo)
    }

    // MARK: syntax.ts

    @Test(arguments: Fixture.cases("themes", "syntaxThemeNameCases", input: SyntaxInput.self, output: String.self))
    func syntaxThemeName(_ c: Fixture.Case<SyntaxInput, String>) {
        #expect(SyntaxTheme.name(c.input.appearance, c.input.syntaxTheme, failed: Set(c.input.failed)) == c.output)
    }

    @Test(arguments: Fixture.cases("themes", "viewerThemesCases", input: ViewerInput.self, output: ViewerThemes.self))
    func viewerThemes(_ c: Fixture.Case<ViewerInput, ViewerThemes>) {
        #expect(SyntaxTheme.viewerThemes(c.input.appearance, c.input.name) == c.output)
    }

    // MARK: projectColor.ts

    @Test(arguments: Fixture.cases("themes", "projectKeyColorsCases", input: KeyColorsInput.self, output: ProjectKeyColors.self))
    func projectKeyColors(_ c: Fixture.Case<KeyColorsInput, ProjectKeyColors>) throws {
        let theme = try #require(Themes.find(c.input.themeId))
        #expect(ProjectKeyColors.for(c.input.color, tokens: theme.tokens) == c.output)
        // Second call is served from the cache and must agree.
        #expect(ProjectKeyColors.for(c.input.color, tokens: theme.tokens) == c.output)
    }

    @Test func projectKeyColorsFallBackOnUnparseableSurfaces() throws {
        var tokens = try #require(Themes.find("harness-light")).tokens
        tokens.bgColumn = "var(--nope)"
        #expect(ProjectKeyColors.for("red", tokens: tokens) == ProjectKeyColors(bg: tokens.accentSoft, fg: tokens.accentText))
    }

    // MARK: Box shadows

    @Test(arguments: Fixture.cases("themes", "boxShadowCases", input: String.self, output: [ShadowOutput]?.self))
    func boxShadow(_ c: Fixture.Case<String, [ShadowOutput]?>) {
        #expect(BoxShadow.parseList(c.input)?.map(ShadowOutput.init) == c.output)
        #expect(BoxShadow.parse(c.input).map(ShadowOutput.init) == c.output?.first)
    }
}
