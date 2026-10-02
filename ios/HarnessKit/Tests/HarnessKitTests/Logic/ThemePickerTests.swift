import Foundation
import Testing
@testable import HarnessKit

@Suite("ThemePicker")
struct ThemePickerTests {
    struct PickerInput: Decodable, Sendable {
        let appearance: ThemeAppearance
        let prefs: ThemePicker.ThemePrefs
        let systemDark: Bool
    }

    struct OptionRow: Decodable, Sendable, Equatable {
        let id: String
        let appearance: ThemeAppearance
        let selected: Bool
        let active: Bool
    }

    @Test(arguments: Fixture.cases("themePicker", "themeOptionsCases", input: PickerInput.self, output: [OptionRow].self))
    func themeOptions(_ c: Fixture.Case<PickerInput, [OptionRow]>) {
        let got = ThemePicker.themeOptions(c.input.appearance, prefs: c.input.prefs, systemDark: c.input.systemDark)
        #expect(got.map { OptionRow(id: $0.theme.id, appearance: $0.theme.appearance, selected: $0.selected, active: $0.active) } == c.output)
    }

    @Test(arguments: Fixture.cases("themePicker", "pickerCaptionCases", input: PickerInput.self, output: String.self))
    func pickerCaption(_ c: Fixture.Case<PickerInput, String>) {
        #expect(ThemePicker.pickerCaption(c.input.appearance, prefs: c.input.prefs, systemDark: c.input.systemDark) == c.output)
    }

    @Test(arguments: Fixture.cases("themePicker", "themePrefKeyCases", input: ThemeAppearance.self, output: String.self))
    func themePrefKey(_ c: Fixture.Case<ThemeAppearance, String>) {
        let key = ThemePicker.themePrefKey(c.input)
        #expect(key.rawValue == c.output)
        // The key path writes the field the fixture's key names.
        var p = Prefs.defaults
        p[keyPath: key.keyPath] = "picked"
        #expect((c.output == "lightTheme" ? p.lightTheme : p.darkTheme) == "picked")
    }

    @Test(arguments: Fixture.cases("themePicker", "themeLinkPrefsCases", input: [String: JSONValue].self, output: ThemePicker.ThemePrefsPatch.self))
    func themeLinkPrefs(_ c: Fixture.Case<[String: JSONValue], ThemePicker.ThemePrefsPatch>) {
        #expect(ThemePicker.themeLinkPrefs(c.input) == c.output)
    }

    /// Query items: a repeated param is an array (dropped), a lone one a string.
    @Test func queryItems() throws {
        let url = try #require(URLComponents(string: "harness://settings?darkTheme=dracula&darkTheme=nord&lightTheme=github-light&theme=light"))
        let got = ThemePicker.themeLinkPrefs(queryItems: url.queryItems ?? [])
        #expect(got == ThemePicker.ThemePrefsPatch(theme: .light, lightTheme: "github-light"))
        let applied = got.applied(to: Prefs.defaults)
        #expect(applied.theme == .light && applied.lightTheme == "github-light" && applied.darkTheme == Prefs.defaults.darkTheme)
    }
}
