import Testing
@testable import HarnessKit

typealias WatcherModelsMap = [String: String?]

struct WatcherCommandInput: Decodable, Sendable {
    let command: String
    let args: [String]?
}

struct WatcherDriverInput: Decodable, Sendable {
    struct W: Decodable, Sendable { let driver: String? }
    struct S: Decodable, Sendable {
        let defaultDriver: String
        let watcherDriver: String?
    }
    let watcher: W?
    let settings: S
}

struct WatcherModelInput: Decodable, Sendable {
    struct W: Decodable, Sendable { let models: WatcherModelsMap? }
    struct S: Decodable, Sendable {
        let watcherModels: WatcherModelsMap?
        let defaultModels: WatcherModelsMap?
    }
    let driver: String
    let watcher: W?
    let settings: S?
}

struct WatcherChoiceInput: Decodable, Sendable {
    struct W: Decodable, Sendable {
        let driver: String?
        let models: WatcherModelsMap?
    }
    let watcher: W?
    let settings: WatcherDriverInput.S
}

struct ReplaceModelsInput: Decodable, Sendable {
    let current: WatcherModelsMap?
    let keep: Watchers.TriageChoice
}

struct WatcherChoiceBodyInput: Decodable, Sendable {
    let choice: Watchers.TriageChoice
    let current: WatcherModelInput.W?
}

struct SettingsWatcherChoiceInput: Decodable, Sendable {
    let defaultDriver: String
    let watcherDriver: String?
    let watcherModels: WatcherModelsMap?
}

struct SettingsWatcherChoicePatchInput: Decodable, Sendable {
    let choice: Watchers.TriageChoice
    let watcherModels: WatcherModelsMap?
}

struct WatcherEntityInput<S: Decodable & Sendable>: Decodable, Sendable {
    let watcher: Watcher?
    let settings: S
}

struct WatcherEntityOutput: Decodable, Sendable, Equatable {
    let commandLine: String?
    let driver: String
    let model: String?
    let choice: Watchers.TriageChoice
    let settingsChoice: Watchers.TriageChoice
    let body: WatcherBody
    let patch: SettingsPatch
}

private func entityOutput(_ w: Watcher?, _ s: some WatcherTriageSettings) -> WatcherEntityOutput {
    let driver = Watchers.watcherDriver(w, settings: s)
    return WatcherEntityOutput(
        commandLine: w.map(Watchers.watcherCommandLine),
        driver: driver,
        model: Watchers.watcherModel(driver, watcher: w, settings: s),
        choice: Watchers.watcherChoice(w, settings: s),
        settingsChoice: Watchers.settingsWatcherChoice(s),
        body: Watchers.watcherChoiceBody(Watchers.TriageChoice(driver: "codex", model: "luna"), current: w),
        patch: Watchers.settingsWatcherChoicePatch(Watchers.defaultTriageChoice, settings: s)
    )
}

@Suite("watchers.ts parity")
struct WatchersTests {
    @Test func constants() throws {
        #expect(Watchers.outputTitleMax == (try Fixture.value("watchers", "outputTitleMax", as: Int.self)))
        #expect(Watchers.defaultTriageChoice == (try Fixture.value("watchers", "defaultTriageChoice", as: Watchers.TriageChoice.self)))
    }

    @Test(arguments: Fixture.cases("watchers", "shellQuoteCases", input: String.self, output: String.self))
    func shellQuote(_ c: Fixture.Case<String, String>) {
        #expect(Array(Watchers.shellQuote(c.input).unicodeScalars) == Array(c.output.unicodeScalars))
    }

    @Test(arguments: Fixture.cases("watchers", "watcherCommandLineCases", input: WatcherCommandInput.self, output: String.self))
    func watcherCommandLine(_ c: Fixture.Case<WatcherCommandInput, String>) {
        #expect(Watchers.watcherCommandLine(command: c.input.command, args: c.input.args) == c.output)
    }

    @Test(arguments: Fixture.cases("watchers", "outputTitleCases", input: String.self, output: String.self))
    func outputTitle(_ c: Fixture.Case<String, String>) {
        let got = Watchers.outputTitle(c.input)
        #expect(Array(got.unicodeScalars) == Array(c.output.unicodeScalars))
        #expect(got.utf16.count <= Watchers.outputTitleMax)
    }

    @Test(arguments: Fixture.cases("watchers", "watcherDriverCases", input: WatcherDriverInput.self, output: String.self))
    func watcherDriver(_ c: Fixture.Case<WatcherDriverInput, String>) {
        let got = Watchers.watcherDriver(c.input.watcher?.driver, watcherDriver: c.input.settings.watcherDriver, defaultDriver: c.input.settings.defaultDriver)
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("watchers", "watcherModelCases", input: WatcherModelInput.self, output: String?.self))
    func watcherModel(_ c: Fixture.Case<WatcherModelInput, String?>) {
        let got = Watchers.watcherModel(
            c.input.driver, models: c.input.watcher?.models, watcherModels: c.input.settings?.watcherModels, defaultModels: c.input.settings?.defaultModels
        )
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("watchers", "watcherChoiceCases", input: WatcherChoiceInput.self, output: Watchers.TriageChoice.self))
    func watcherChoice(_ c: Fixture.Case<WatcherChoiceInput, Watchers.TriageChoice>) {
        let got = Watchers.watcherChoice(
            driver: c.input.watcher?.driver, models: c.input.watcher?.models, watcherDriver: c.input.settings.watcherDriver,
            defaultDriver: c.input.settings.defaultDriver
        )
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("watchers", "replaceModelsCases", input: ReplaceModelsInput.self, output: WatcherModelsMap.self))
    func replaceModels(_ c: Fixture.Case<ReplaceModelsInput, WatcherModelsMap>) {
        #expect(Watchers.replaceModels(c.input.current, keep: c.input.keep) == c.output)
    }

    @Test(arguments: Fixture.cases("watchers", "watcherChoiceBodyCases", input: WatcherChoiceBodyInput.self, output: WatcherBody.self))
    func watcherChoiceBody(_ c: Fixture.Case<WatcherChoiceBodyInput, WatcherBody>) {
        #expect(Watchers.watcherChoiceBody(c.input.choice, currentModels: c.input.current?.models) == c.output)
    }

    @Test(arguments: Fixture.cases("watchers", "settingsWatcherChoiceCases", input: SettingsWatcherChoiceInput.self, output: Watchers.TriageChoice.self))
    func settingsWatcherChoice(_ c: Fixture.Case<SettingsWatcherChoiceInput, Watchers.TriageChoice>) {
        let got = Watchers.settingsWatcherChoice(watcherDriver: c.input.watcherDriver, defaultDriver: c.input.defaultDriver, watcherModels: c.input.watcherModels)
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("watchers", "settingsWatcherChoicePatchCases", input: SettingsWatcherChoicePatchInput.self, output: SettingsPatch.self))
    func settingsWatcherChoicePatch(_ c: Fixture.Case<SettingsWatcherChoicePatchInput, SettingsPatch>) {
        #expect(Watchers.settingsWatcherChoicePatch(c.input.choice, watcherModels: c.input.watcherModels) == c.output)
    }

    @Test(arguments: Fixture.cases("watchers", "watcherEntityCases", input: WatcherEntityInput<Settings>.self, output: WatcherEntityOutput.self))
    func entities(_ c: Fixture.Case<WatcherEntityInput<Settings>, WatcherEntityOutput>) {
        #expect(entityOutput(c.input.watcher, c.input.settings) == c.output)
    }

    @Test(arguments: Fixture.cases("watchers", "watcherPublicSettingsEntityCases", input: WatcherEntityInput<PublicSettings>.self, output: WatcherEntityOutput.self))
    func publicSettingsEntities(_ c: Fixture.Case<WatcherEntityInput<PublicSettings>, WatcherEntityOutput>) {
        #expect(entityOutput(c.input.watcher, c.input.settings) == c.output)
    }
}
