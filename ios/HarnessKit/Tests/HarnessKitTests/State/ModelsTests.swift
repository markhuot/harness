import Foundation
import Testing
@testable import HarnessKit

/// A Swift value as JSON, for comparing PATCH bodies key-for-key (absent vs null) with TS output.
func modelsJSON(_ value: some Encodable) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
}

struct ModelNameInput: Decodable, Sendable {
    let models: [ModelInfo]?
    let id: String
}

struct ModelOptionsInput: Decodable, Sendable {
    struct O: Decodable, Sendable {
        let inherited: String?
        let defaultLabel: String?
        let plainDefault: Bool?
    }
    let models: [ModelInfo]?
    let value: String?
    let opts: O?
}

struct InheritedModelInput: Decodable, Sendable {
    let driver: String
    let level: Models.Level
    let project: ModelProject?
    let settings: ModelSettings?
}

struct DriverModelChoicesInput: Decodable, Sendable {
    struct O: Decodable, Sendable {
        let defaultLabel: String?
        let onlyDriver: String?
        let inheritedModels: [String: String?]?
    }
    let drivers: [ChoiceDriver]
    let models: [String: [ModelInfo]]
    let value: TriageChoice
    let resolved: TriageChoice
    let opts: O?
}

struct FilterChoiceGroupsInput: Decodable, Sendable {
    let groups: [ChoiceGroup]
    let query: String
    let driverNames: [String: String]?
}

struct ModelsProjectSettingsInput: Decodable, Sendable {
    let project: ModelProject?
    let settings: ModelSettings?
}

struct ModelsTicketChoiceInput: Decodable, Sendable {
    struct T: Decodable, Sendable {
        let driver: String
        let model: String?
    }
    let ticket: T
    let project: ModelProject?
    let settings: ModelSettings?
}

struct ModelsChoicePatchInput: Decodable, Sendable {
    let choice: TriageChoice
    let project: ModelProject?
    let settings: ModelSettings?
}

struct ModelsProjectChoiceInput: Decodable, Sendable {
    let project: ModelProject
    let settings: ModelSettings?
}

struct ModelsProjectChoicePatchInput: Decodable, Sendable {
    let choice: TriageChoice
    let project: ModelProject
}

struct ModelsSettingsChoicePatchInput: Decodable, Sendable {
    let choice: TriageChoice
    let settings: ModelSettings
}

/// A protocol Settings or PublicSettings sample, through the matching `ModelSettings` init.
struct ModelsAnySettings: Decodable, Sendable {
    let value: ModelSettings
    init(from decoder: any Decoder) throws {
        if let s = try? PublicSettings(from: decoder) { value = ModelSettings(s) } else { value = ModelSettings(try Settings(from: decoder)) }
    }
}

struct ModelEntityInput: Decodable, Sendable {
    let project: Project?
    let settings: ModelsAnySettings?
    let ticket: ModelsTicketChoiceInput.T
}

struct ModelEntityOutput: Decodable, Sendable {
    let projectDriver: String
    let resolved: TriageChoice
    let ticketChoice: TriageChoice
    let ticketPatch: JSONValue
    let inheritedTicket: String?
    let projectChoice: TriageChoice?
    let projectPatch: JSONValue?
    let settingsChoice: TriageChoice?
    let settingsPatch: JSONValue?
}

@Suite("state/models.ts parity")
struct ModelsTests {
    @Test func separator() throws {
        #expect(String(Models.sep) == (try Fixture.value("stateModels", "sep", as: String.self)))
    }

    @Test(arguments: Fixture.cases("stateModels", "modelNameCases", input: ModelNameInput.self, output: String.self))
    func modelName(_ c: Fixture.Case<ModelNameInput, String>) {
        #expect(Models.modelName(c.input.models, c.input.id) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "modelOptionsCases", input: ModelOptionsInput.self, output: [ModelOption].self))
    func modelOptions(_ c: Fixture.Case<ModelOptionsInput, [ModelOption]>) {
        let o = c.input.opts
        let opts = Models.ModelOptionsOptions(inherited: o?.inherited, defaultLabel: o?.defaultLabel, plainDefault: o?.plainDefault ?? false)
        #expect(Models.modelOptions(c.input.models, value: c.input.value, opts) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "inheritedModelCases", input: InheritedModelInput.self, output: String?.self))
    func inheritedModel(_ c: Fixture.Case<InheritedModelInput, String?>) {
        #expect(Models.inheritedModel(c.input.driver, level: c.input.level, project: c.input.project, settings: c.input.settings) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "encodeChoiceCases", input: TriageChoice.self, output: String.self))
    func encodeChoice(_ c: Fixture.Case<TriageChoice, String>) {
        #expect(Array(Models.encodeChoice(c.input).unicodeScalars) == Array(c.output.unicodeScalars))
    }

    @Test(arguments: Fixture.cases("stateModels", "decodeChoiceCases", input: String.self, output: TriageChoice.self))
    func decodeChoice(_ c: Fixture.Case<String, TriageChoice>) {
        let got = Models.decodeChoice(c.input)
        #expect(got == c.output)
        // Round trip: a decoded value encodes back to the input, except where decoding is lossy
        // (no separator, or an empty driver that encodes as Default).
        if c.input.unicodeScalars.contains(Models.sep), got.driver?.isEmpty == false {
            #expect(Models.encodeChoice(got).unicodeScalars.elementsEqual(c.input.unicodeScalars))
        }
    }

    @Test(arguments: Fixture.cases("stateModels", "driverModelChoicesCases", input: DriverModelChoicesInput.self, output: ChoiceOptions.self))
    func driverModelChoices(_ c: Fixture.Case<DriverModelChoicesInput, ChoiceOptions>) {
        let o = c.input.opts
        var inherited: (@Sendable (String) -> String?)?
        if let map = o?.inheritedModels {
            inherited = { driver in map[driver] ?? nil }
        }
        let opts = Models.DriverModelChoicesOptions(defaultLabel: o?.defaultLabel, onlyDriver: o?.onlyDriver, inheritedModel: inherited)
        let got = Models.driverModelChoices(c.input.drivers, models: c.input.models, value: c.input.value, resolved: c.input.resolved, opts)
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "filterChoiceGroupsCases", input: FilterChoiceGroupsInput.self, output: [ChoiceGroup].self))
    func filterChoiceGroups(_ c: Fixture.Case<FilterChoiceGroupsInput, [ChoiceGroup]>) {
        let got = Models.filterChoiceGroups(c.input.groups, c.input.query, driverNames: c.input.driverNames ?? [:])
        #expect(got == c.output)
        // Swift's String == is canonical-equivalence based; pin the labels scalar for scalar.
        #expect(got.flatMap { $0.options.map { Array($0.label.unicodeScalars) } } == c.output.flatMap { $0.options.map { Array($0.label.unicodeScalars) } })
    }

    @Test(arguments: Fixture.cases("stateModels", "projectDriverCases", input: ModelsProjectSettingsInput.self, output: String.self))
    func projectDriver(_ c: Fixture.Case<ModelsProjectSettingsInput, String>) {
        #expect(Models.projectDriver(c.input.project, c.input.settings) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "ticketChoiceCases", input: ModelsTicketChoiceInput.self, output: TriageChoice.self))
    func ticketChoice(_ c: Fixture.Case<ModelsTicketChoiceInput, TriageChoice>) {
        #expect(Models.ticketChoice(driver: c.input.ticket.driver, model: c.input.ticket.model, c.input.project, c.input.settings) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "ticketResolvedChoiceCases", input: ModelsProjectSettingsInput.self, output: TriageChoice.self))
    func ticketResolvedChoice(_ c: Fixture.Case<ModelsProjectSettingsInput, TriageChoice>) {
        #expect(Models.ticketResolvedChoice(c.input.project, c.input.settings) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "ticketChoicePatchCases", input: ModelsChoicePatchInput.self, output: JSONValue.self))
    func ticketChoicePatch(_ c: Fixture.Case<ModelsChoicePatchInput, JSONValue>) throws {
        #expect(try modelsJSON(Models.ticketChoicePatch(c.input.choice, c.input.project, c.input.settings)) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "projectChoiceCases", input: ModelsProjectChoiceInput.self, output: TriageChoice.self))
    func projectChoice(_ c: Fixture.Case<ModelsProjectChoiceInput, TriageChoice>) {
        #expect(Models.projectChoice(c.input.project, c.input.settings) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "projectChoicePatchCases", input: ModelsProjectChoicePatchInput.self, output: JSONValue.self))
    func projectChoicePatch(_ c: Fixture.Case<ModelsProjectChoicePatchInput, JSONValue>) throws {
        #expect(try modelsJSON(Models.projectChoicePatch(c.input.choice, c.input.project)) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "settingsChoiceCases", input: ModelSettings.self, output: TriageChoice.self))
    func settingsChoice(_ c: Fixture.Case<ModelSettings, TriageChoice>) {
        #expect(Models.settingsChoice(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "settingsChoicePatchCases", input: ModelsSettingsChoicePatchInput.self, output: JSONValue.self))
    func settingsChoicePatch(_ c: Fixture.Case<ModelsSettingsChoicePatchInput, JSONValue>) throws {
        #expect(try modelsJSON(Models.settingsChoicePatch(c.input.choice, c.input.settings)) == c.output)
    }

    /// The real Project / Settings / PublicSettings entities through the ModelProject and
    /// ModelSettings conversions.
    @Test(arguments: Fixture.cases("stateModels", "entityCases", input: ModelEntityInput.self, output: ModelEntityOutput.self))
    func entities(_ c: Fixture.Case<ModelEntityInput, ModelEntityOutput>) throws {
        let p = c.input.project.map(ModelProject.init)
        let s = c.input.settings?.value
        let t = c.input.ticket
        #expect(Models.projectDriver(p, s) == c.output.projectDriver)
        #expect(Models.ticketResolvedChoice(p, s) == c.output.resolved)
        #expect(Models.ticketChoice(driver: t.driver, model: t.model, p, s) == c.output.ticketChoice)
        #expect(try modelsJSON(Models.ticketChoicePatch(Watchers.defaultTriageChoice, p, s)) == c.output.ticketPatch)
        #expect(Models.inheritedModel("claude-code", level: .ticket, project: p, settings: s) == c.output.inheritedTicket)
        #expect(p.map { Models.projectChoice($0, s) } == c.output.projectChoice)
        #expect(try p.map { try modelsJSON(Models.projectChoicePatch(TriageChoice(driver: "claude-code", model: "haiku"), $0)) } == c.output.projectPatch)
        #expect(s.map(Models.settingsChoice) == c.output.settingsChoice)
        #expect(try s.map { try modelsJSON(Models.settingsChoicePatch(Watchers.defaultTriageChoice, $0)) } == c.output.settingsPatch)
    }

    @Test func driverInfoConversionKeepsTheSelectFields() {
        let d = DriverInfo(id: "codex", name: "Codex", description: "x", available: true, authenticated: false, detail: "", supportsLogin: false)
        #expect(ChoiceDriver(d) == ChoiceDriver(id: "codex", name: "Codex", available: true, authenticated: false))
    }
}

// MARK: - ModelListCache

/// A scripted model fetch: each call parks until the test resolves or fails it.
@MainActor
final class ScriptedModels {
    var calls: [String] = []
    var pending: [(id: String, cont: CheckedContinuation<DriverModels, any Error>)] = []

    func fetch(_ id: String, _ refresh: Bool) async throws -> DriverModels {
        calls.append(refresh ? "\(id)!" : id)
        return try await withCheckedThrowingContinuation { pending.append((id, $0)) }
    }

    func resolve(_ index: Int = 0, _ models: [String]) {
        let p = pending.remove(at: index)
        p.cont.resume(returning: DriverModels(driverId: p.id, models: models.map { ModelInfo(id: $0, name: $0) }, fetchedAt: 1))
    }

    func fail(_ index: Int = 0, _ error: any Error) {
        pending.remove(at: index).cont.resume(throwing: error)
    }

    /// Lets started loads run until `n` fetches are parked (the tests' expectations on `calls`
    /// catch a wrong count).
    func waitForPending(_ n: Int) async {
        for _ in 0..<1000 where pending.count < n { await Task.yield() }
        #expect(pending.count == n, "pending fetches")
    }
}

struct ModelsOffline: Error, CustomStringConvertible {
    var description: String { "offline" }
}

@MainActor
@Suite("ModelListCache")
struct ModelListCacheTests {
    let script = ScriptedModels()
    let cache: ModelListCache

    init() {
        let script = script
        cache = ModelListCache { id, refresh in try await script.fetch(id, refresh) }
    }

    private func ids(_ id: String) -> [String]? { cache.get(id).data?.models.map(\.id) }

    @Test func concurrentLoadsShareOneFetch() async {
        let a1 = Task { await cache.load("a") }
        let a2 = Task { await cache.load("a") }
        let b = Task { await cache.load("b") }
        await script.waitForPending(2)
        #expect(script.calls == ["a", "b"])
        #expect(cache.get("a").loading)
        script.resolve(0, ["a-m"])
        script.resolve(0, ["b-m"])
        await a1.value
        await a2.value
        await b.value
        #expect(ids("a") == ["a-m"])
        #expect(ids("b") == ["b-m"])
        #expect(cache.get("a").loading == false)
        // Loaded: no second fetch.
        await cache.load("a")
        #expect(script.calls == ["a", "b"])
    }

    @Test func aJoinedLoadWaitsForTheSharedResult() async {
        let first = Task { await cache.load("a") }
        await script.waitForPending(1)
        let joined = Task { () -> [String]? in
            await cache.load("a")
            return cache.get("a").data?.models.map(\.id)
        }
        for _ in 0..<50 { await Task.yield() }
        script.resolve(0, ["a-m"])
        #expect(await joined.value == ["a-m"])
        await first.value
    }

    @Test func refreshBypassesTheSharedRequestAndTheLastToSettleWins() async {
        let plain = Task { await cache.load("a") }
        await script.waitForPending(1)
        let refreshed = Task { await cache.load("a", refresh: true) }
        await script.waitForPending(2)
        #expect(script.calls == ["a", "a!"])
        script.resolve(1, ["new"])
        await refreshed.value
        #expect(ids("a") == ["new"])
        script.resolve(0, ["old"])
        await plain.value
        #expect(ids("a") == ["old"])
    }

    @Test func refreshOfALoadedDriverRefetches() async {
        let t = Task { await cache.load("a") }
        await script.waitForPending(1)
        script.resolve(0, ["v1"])
        await t.value
        let r = Task { await cache.load("a", refresh: true) }
        await script.waitForPending(1)
        #expect(cache.get("a").loading)
        #expect(ids("a") == ["v1"], "the old list stays visible while refreshing")
        script.resolve(0, ["v2"])
        await r.value
        #expect(script.calls == ["a", "a!"])
        #expect(ids("a") == ["v2"])
    }

    @Test func failureKeepsTheLastDataAndAnErroredDriverIsNotRetried() async {
        let t = Task { await cache.load("a") }
        await script.waitForPending(1)
        script.resolve(0, ["a-m"])
        await t.value

        let r = Task { await cache.load("a", refresh: true) }
        await script.waitForPending(1)
        script.fail(0, ModelsOffline())
        await r.value
        #expect(cache.get("a").error == "offline")
        #expect(cache.get("a").loading == false)
        #expect(ids("a") == ["a-m"])

        await cache.load("a")
        #expect(script.calls == ["a", "a!"], "an errored driver isn't hammered by every select")

        // A successful refresh clears the error.
        let again = Task { await cache.load("a", refresh: true) }
        await script.waitForPending(1)
        script.resolve(0, ["a-2"])
        await again.value
        #expect(cache.get("a").error == nil)
        #expect(ids("a") == ["a-2"])
    }

    @Test func firstFailureHasNoDataAndUsesTheServiceMessage() async {
        let t = Task { await cache.load("x") }
        await script.waitForPending(1)
        script.fail(0, HarnessAPIError(status: 404, message: "Unknown driver: x"))
        await t.value
        #expect(cache.get("x") == ModelListState(data: nil, loading: false, error: "Unknown driver: x"))
        await cache.load("x")
        #expect(script.calls == ["x"])
    }

    @Test func syncEpochClearsOnlyOnAHigherEpoch() async {
        let t = Task { await cache.load("a") }
        await script.waitForPending(1)
        script.resolve(0, ["v1"])
        await t.value

        cache.syncEpoch(0)
        #expect(ids("a") == ["v1"])
        cache.syncEpoch(1)
        #expect(cache.get("a") == .empty)

        let t2 = Task { await cache.load("a") }
        await script.waitForPending(1)
        script.resolve(0, ["v2"])
        await t2.value
        cache.syncEpoch(1)
        cache.syncEpoch(0)
        #expect(ids("a") == ["v2"])
        cache.syncEpoch(5)
        #expect(cache.get("a").data == nil)
    }

    @Test func syncEpochDropsTheSharedRequestButTheStaleResultStillLands() async {
        let stale = Task { await cache.load("a") }
        await script.waitForPending(1)
        cache.syncEpoch(1)
        #expect(cache.get("a") == .empty)
        // The in-flight request was dropped, so a new load fetches again instead of joining it.
        let fresh = Task { await cache.load("a") }
        await script.waitForPending(2)
        #expect(script.calls == ["a", "a"])
        script.resolve(1, ["fresh"])
        await fresh.value
        // As in TS, the request from before the reconnect still writes when it settles.
        script.resolve(0, ["stale"])
        await stale.value
        #expect(ids("a") == ["stale"])
    }

    @Test func emptyDriverIdIsANoOp() async {
        await cache.load("")
        await cache.load("", refresh: true)
        #expect(script.calls.isEmpty)
        #expect(cache.get("") == .empty)
        #expect(cache.version == 0)
    }

    @Test func versionBumpsOnEveryChange() async {
        #expect(cache.version == 0)
        let t = Task { await cache.load("a") }
        await script.waitForPending(1)
        #expect(cache.version == 1, "loading")
        script.resolve(0, ["m"])
        await t.value
        #expect(cache.version == 2, "loaded")
        await cache.load("a")
        #expect(cache.version == 2, "a skipped load changes nothing")
        cache.syncEpoch(0)
        #expect(cache.version == 2, "a stale epoch changes nothing")
        cache.syncEpoch(1)
        #expect(cache.version == 3, "cleared")
    }

    @Test func getIsObserved() async {
        nonisolated(unsafe) var changed = false
        withObservationTracking { _ = cache.get("a") } onChange: { changed = true }
        let t = Task { await cache.load("a") }
        await script.waitForPending(1)
        #expect(changed)
        script.resolve(0, ["m"])
        await t.value
    }

    @Test func clientCacheFetchesTheDriverListEndpoint() async throws {
        let body = #"{"data":{"driverId":"claude-code","models":[{"id":"opus","name":"Opus","default":true}],"error":null,"fetchedAt":1}}"#
        let transport = FakeTransport(status: 200, body: body)
        let cache = ModelListCache(client: HarnessClient(baseUrl: "http://h:1", token: "t", transport: transport))
        await cache.load("claude-code", refresh: true)
        #expect(transport.last?.url.absoluteString == "http://h:1/drivers/claude-code/models?refresh=1")
        #expect(cache.get("claude-code").data?.models.first?.name == "Opus")
    }
}

struct PhaseMatrixInput: Decodable, Sendable {
    let value: PhaseModels?
    let inherited: PerPhase<PhaseChoice>?
    let query: String?
}

struct PhasePickPatchInput: Decodable, Sendable {
    let phase: Phase
    let choice: PhaseChoice?
}

/// phaseMatrix plus the type-ahead's groups (`filtered`, null without a query), as the fixture returns them.
private struct PhaseMatrixOutput: Encodable {
    let matrix: PhaseMatrix
    let filtered: [PhaseGroup]?

    func encode(to encoder: any Encoder) throws {
        try matrix.encode(to: encoder)
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        if let filtered { try c.encode(filtered, forKey: "filtered") } else { try c.encodeNil(forKey: "filtered") }
    }
}

@Suite("state/models.ts parity: the per-phase picker")
struct PhaseModelsTests {
    /// The drivers stateModels.ts builds its matrices from.
    static let drivers = [
        ChoiceDriver(id: "claude-code", name: "Claude Code", available: true, authenticated: true),
        ChoiceDriver(id: "anthropic-api", name: "Anthropic API", available: true, authenticated: true),
        ChoiceDriver(id: "codex", name: "Codex", available: true, authenticated: false),
    ]
    static let models: [String: [ModelInfo]] = [
        "claude-code": [ModelInfo(id: "opus", name: "Opus 5.5", default: true), ModelInfo(id: "haiku", name: "Haiku 5.5")],
        "codex": [ModelInfo(id: "luna", name: "Luna")],
    ]

    @Test(arguments: Fixture.cases("stateModels", "phaseMatrixCases", input: PhaseMatrixInput.self, output: JSONValue.self))
    func phaseMatrix(_ c: Fixture.Case<PhaseMatrixInput, JSONValue>) throws {
        let m = Models.phaseMatrix(Self.drivers, models: Self.models, value: c.input.value, inherited: c.input.inherited)
        let out = PhaseMatrixOutput(matrix: m, filtered: c.input.query.map { Models.filterPhaseGroups(m.groups, $0) })
        #expect(try modelsJSON(out) == c.output)
    }

    @Test(arguments: Fixture.cases("stateModels", "phasePickPatchCases", input: PhasePickPatchInput.self, output: JSONValue.self))
    func phasePickPatch(_ c: Fixture.Case<PhasePickPatchInput, JSONValue>) throws {
        #expect(try modelsJSON(Models.phasePickPatch(c.input.phase, choice: c.input.choice)) == c.output)
    }

    @Test func inheritedPhaseModelsResolveOneLevelUp() {
        let settings = PhaseModels(work: PhaseChoice(driver: "claude-code", model: "opus"))
        let project = PhaseModels(review: PhaseChoice(driver: "codex", model: nil))
        #expect(Phases.inheritedPhaseModels(.settings, project: project, settings: settings) == nil)
        let ticket = Phases.inheritedPhaseModels(.ticket, project: project, settings: settings)
        #expect(ticket?.review == PhaseChoice(driver: "codex", model: nil))
        #expect(ticket?.plan == PhaseChoice(driver: "claude-code", model: nil))
        #expect(ticket?.work == PhaseChoice(driver: "claude-code", model: "opus"))
        // A project inherits settings only.
        #expect(Phases.inheritedPhaseModels(.project, project: project, settings: settings)?.review == PhaseChoice(driver: "claude-code", model: nil))
        // Nothing set: claude-code with its default model.
        #expect(Phases.settingsPhaseChoice(nil, .complete) == PhaseChoice(driver: "claude-code", model: nil))
    }

    @Test func mergeSetsAndClearsPhases() {
        let current = PhaseModels(work: PhaseChoice(driver: "claude-code", model: "opus"), complete: PhaseChoice(driver: "claude-code", model: "haiku"))
        let merged = Phases.mergePhaseModels(current, PhaseModelsPatch(work: .null, review: .value(PhaseChoice(driver: "codex", model: "")), complete: .value(PhaseChoice(driver: "", model: "x"))))
        #expect(merged == PhaseModels(review: PhaseChoice(driver: "codex", model: nil)))
        #expect(Phases.samePhaseChoice(PhaseChoice(driver: "a", model: ""), PhaseChoice(driver: "a", model: nil)))
        #expect(!Phases.samePhaseChoice(PhaseChoice(driver: "a", model: nil), nil))
        #expect(Phases.samePhaseChoice(nil, nil))
    }

    @Test func patchEncodesNullToClearAndOmitsTheRest() throws {
        let body = UpdateTicketBody(phaseModels: PhaseModelsPatch(plan: .null, work: .value(PhaseChoice(driver: "codex", model: nil))))
        #expect(try modelsJSON(body) == .object(["phaseModels": .object(["plan": .null, "work": .object(["driver": .string("codex"), "model": .null])])]))
    }
}
