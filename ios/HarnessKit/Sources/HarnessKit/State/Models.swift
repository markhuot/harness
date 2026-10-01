import Foundation
import Observation

// Port of shared/src/state/models.ts. Model selection helpers: the per-driver model list cache
// (fetched from GET /drivers/:id/models and shared by every select on screen) and pure
// option/label derivations.
//
// JS semantics kept: `||` and `x ? … : …` treat nil and "" alike (`nonEmpty`), while `??` only skips
// nil, and the two are not interchangeable here (`choice.driver ?? projectDriver(…)` keeps an empty
// driver). The type-ahead lower-cases like `toLowerCase()`, splits on JS `\s`, and matches with
// `includes` on UTF-16 code units.

public typealias TriageChoice = Watchers.TriageChoice

public struct ModelOption: Codable, Sendable, Equatable, Hashable {
    /// "" is the inherit / default option (sent as null)
    public var value: String
    public var label: String

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

public struct ChoiceGroup: Codable, Sendable, Equatable {
    public var driver: String
    /// The driver's name, or null when the list collapses to one driver (no group heading)
    @Nullable public var label: String?
    public var options: [ModelOption]

    public init(driver: String, label: String?, options: [ModelOption]) {
        self.driver = driver
        self.label = label
        self.options = options
    }
}

public struct ChoiceOptions: Codable, Sendable, Equatable {
    /// The Default option (value ""), naming what it resolves to; null when it isn't offered (see onlyDriver)
    @Nullable public var `default`: ModelOption?
    public var groups: [ChoiceGroup]
    /// Label of the picked option (for triggers that show text, like the iOS menu)
    public var selectedLabel: String

    public init(default def: ModelOption?, groups: [ChoiceGroup], selectedLabel: String) {
        self.default = def
        self.groups = groups
        self.selectedLabel = selectedLabel
    }
}

/// The driver fields the combined select reads: `Pick<DriverInfo, "id" | "name" | "available" | "authenticated">`.
public struct ChoiceDriver: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var available: Bool
    public var authenticated: Bool

    public init(id: String, name: String, available: Bool, authenticated: Bool) {
        self.id = id
        self.name = name
        self.available = available
        self.authenticated = authenticated
    }

    public init(_ d: DriverInfo) {
        self.init(id: d.id, name: d.name, available: d.available, authenticated: d.authenticated)
    }
}

/// The project fields model selection reads: `Pick<Project, "defaultDriver" | "defaultModels">`.
public struct ModelProject: Codable, Sendable, Equatable {
    @Nullable public var defaultDriver: String?
    public var defaultModels: [String: String?]?

    public init(defaultDriver: String?, defaultModels: [String: String?]? = [:]) {
        self.defaultDriver = defaultDriver
        self.defaultModels = defaultModels
    }

    public init(_ p: Project) {
        self.init(defaultDriver: p.defaultDriver, defaultModels: p.defaultModels.mapValues { $0 })
    }
}

/// The settings fields model selection reads: `Pick<PublicSettings, "defaultDriver" | "defaultModels">`.
public struct ModelSettings: Codable, Sendable, Equatable {
    public var defaultDriver: String
    public var defaultModels: [String: String?]

    public init(defaultDriver: String, defaultModels: [String: String?] = [:]) {
        self.defaultDriver = defaultDriver
        self.defaultModels = defaultModels
    }

    public init(_ s: PublicSettings) { self.init(defaultDriver: s.defaultDriver, defaultModels: s.defaultModels) }
    public init(_ s: Settings) { self.init(defaultDriver: s.defaultDriver, defaultModels: s.defaultModels) }
}

public enum Models {
    /// Where a model select sits, for `inheritedModel`.
    public enum Level: String, Codable, Sendable {
        case ticket, project, settings
    }

    /// Display name for a model id: the list's name, else the id itself.
    public static func modelName(_ models: [ModelInfo]?, _ id: String) -> String {
        models?.first { $0.id == id }?.name ?? id
    }

    /// The model a null choice falls back to, one level up from where the select sits:
    /// ticket → project default → settings default (→ driver default, returned as nil).
    public static func inheritedModel(_ driver: String, level: Level, project: ModelProject?, settings: ModelSettings?) -> String? {
        if level == .ticket, let m = nonEmpty(project?.defaultModels?[driver] ?? nil) { return m }
        if level != .settings, let m = nonEmpty(settings?.defaultModels[driver] ?? nil) { return m }
        return nil
    }

    public struct ModelOptionsOptions: Sendable, Equatable {
        public var inherited: String?
        public var defaultLabel: String?
        /// don't name what the default resolves to
        public var plainDefault: Bool

        public init(inherited: String? = nil, defaultLabel: String? = nil, plainDefault: Bool = false) {
            self.inherited = inherited
            self.defaultLabel = defaultLabel
            self.plainDefault = plainDefault
        }
    }

    /// Options for a model select: "Default (<what null resolves to>)" first, then the driver's
    /// models (its own default marked), then the current value if the list doesn't have it
    /// (a custom id, or the list failed to load) so the select never silently shows another model.
    public static func modelOptions(_ models: [ModelInfo]?, value: String?, _ opts: ModelOptionsOptions = .init()) -> [ModelOption] {
        let list = models ?? []
        let label = opts.defaultLabel ?? "Default"
        let fallsBackTo: String? =
            opts.plainDefault ? nil : nonEmpty(opts.inherited).map { modelName(list, $0) } ?? list.first { $0.default == true }?.name
        var out = [ModelOption(value: "", label: nonEmpty(fallsBackTo).map { "\(label) (\($0))" } ?? label)]
        for m in list { out.append(ModelOption(value: m.id, label: m.default == true ? "\(m.name) · default" : m.name)) }
        if let value = nonEmpty(value), !list.contains(where: { $0.id == value }) { out.append(ModelOption(value: value, label: "\(value) (custom)")) }
        return out
    }

    /// A model badge is only worth showing when the ticket picked a model itself.
    public static func ticketModelBadge(_ model: String?, _ models: [ModelInfo]?) -> String? {
        nonEmpty(model).map { modelName(models, $0) }
    }

    // MARK: Combined driver + model select (watchers): models grouped under their driver

    static let sep: Unicode.Scalar = "\u{1}"

    /// A TriageChoice as a select value: "" for Default, else "driver\u{1}model" ("driver\u{1}" → the driver's default).
    public static func encodeChoice(_ c: TriageChoice) -> String {
        guard let driver = nonEmpty(c.driver) else { return "" }
        return "\(driver)\u{1}\(c.model ?? "")"
    }

    public static func decodeChoice(_ v: String) -> TriageChoice {
        if v.isEmpty { return Watchers.defaultTriageChoice }
        // U+0001 is one UTF-16 code unit and one scalar, so indexOf/slice line up with scalars.
        let scalars = v.unicodeScalars
        guard let i = scalars.firstIndex(of: sep) else { return TriageChoice(driver: v, model: nil) }
        let model = String(scalars[scalars.index(after: i)...])
        return TriageChoice(driver: String(scalars[..<i]), model: nonEmpty(model))
    }

    public struct DriverModelChoicesOptions: Sendable {
        public var defaultLabel: String?
        public var onlyDriver: String?
        public var inheritedModel: (@Sendable (String) -> String?)?

        public init(defaultLabel: String? = nil, onlyDriver: String? = nil, inheritedModel: (@Sendable (String) -> String?)? = nil) {
            self.defaultLabel = defaultLabel
            self.onlyDriver = onlyDriver
            self.inheritedModel = inheritedModel
        }
    }

    /// Options for the combined Model select. Drivers that are installed and signed in each get a
    /// group of their models; the picked driver is kept even when it isn't signed in, so the select
    /// never hides the current value. With a single group the heading is dropped and the models show as
    /// a flat list. `resolved` is what Default falls back to (driver + model; model nil → the driver's
    /// listed default). A driver picked without a model gets a "<driver> default" entry (naming
    /// `inheritedModel(driver)` when given, else the list's default), and a model the list doesn't have
    /// is kept as "(custom)". `onlyDriver` lists that one driver alone (a ticket mid-run can change its
    /// model but not its driver); Default is then only offered when it resolves to that driver.
    public static func driverModelChoices(
        _ drivers: [ChoiceDriver], models: [String: [ModelInfo]], value: TriageChoice, resolved: TriageChoice,
        _ opts: DriverModelChoicesOptions = .init()
    ) -> ChoiceOptions {
        let only = nonEmpty(opts.onlyDriver)
        var shown = only.map { o in drivers.filter { $0.id == o } } ?? drivers.filter { ($0.available && $0.authenticated) || $0.id == value.driver }
        // `only ?? value.driver` in TS: an empty onlyDriver is falsy above but not nullish here.
        let keep = opts.onlyDriver ?? value.driver
        if let keep = nonEmpty(keep), !shown.contains(where: { $0.id == keep }) {
            shown.append(ChoiceDriver(id: keep, name: keep, available: false, authenticated: false))
        }
        let flat = shown.count <= 1
        func name(_ id: String) -> String { drivers.first { $0.id == id }?.name ?? id }
        func defaultModelName(_ driver: String, _ model: String?) -> String? {
            let list = models[driver]
            // `model ?? inheritedModel?.(driver) ?? null`: an empty model stops the chain.
            let id = model ?? opts.inheritedModel?(driver) ?? nil
            if let id = nonEmpty(id) { return modelName(list, id) }
            return list?.first { $0.default == true }?.name
        }

        let groups = shown.map { d -> ChoiceGroup in
            let list = models[d.id] ?? []
            var options: [ModelOption] = []
            if value.driver == d.id, nonEmpty(value.model) == nil {
                let fallback = defaultModelName(d.id, nil)
                options.append(ModelOption(
                    value: encodeChoice(TriageChoice(driver: d.id, model: nil)),
                    label: nonEmpty(fallback).map { "\(d.name) default (\($0))" } ?? "\(d.name) default"
                ))
            }
            for m in list { options.append(ModelOption(value: encodeChoice(TriageChoice(driver: d.id, model: m.id)), label: m.name)) }
            if value.driver == d.id, let model = nonEmpty(value.model), !list.contains(where: { $0.id == model }) {
                options.append(ModelOption(value: encodeChoice(value), label: "\(model) (custom)"))
            }
            return ChoiceGroup(driver: d.id, label: flat ? nil : d.name, options: options)
        }

        let label = opts.defaultLabel ?? "Default"
        var parts: [String] = []
        if let driver = nonEmpty(resolved.driver) {
            let driverPart: String? = flat && shown.first?.id == driver ? nil : name(driver)
            parts = [driverPart, defaultModelName(driver, resolved.model)].compactMap(nonEmpty)
        }
        let def: ModelOption? =
            only != nil && resolved.driver != only ? nil : ModelOption(value: "", label: parts.isEmpty ? label : "\(label) (\(parts.joined(separator: " · ")))")

        let picked = encodeChoice(value)
        let all = (def.map { [$0] } ?? []) + groups.flatMap(\.options)
        let selectedLabel: String
        if let index = all.firstIndex(where: { $0.value == picked }) {
            let option = all[index]
            let isDefault = def != nil && index == 0
            // `name(value.driver!)`: a nil driver can only get here through a group whose id is ""; JS
            // would print "undefined".
            selectedLabel = isDefault || flat || nonEmpty(value.model) == nil ? option.label : "\(value.driver.map(name) ?? "undefined") · \(option.label)"
        } else {
            selectedLabel = def?.label ?? label
        }
        return ChoiceOptions(default: def, groups: groups, selectedLabel: selectedLabel)
    }

    // MARK: The combined select on tickets, projects and settings: what it shows and what a pick saves

    /// The driver a project's new tickets use: its own default, else the settings default.
    public static func projectDriver(_ project: ModelProject?, _ settings: ModelSettings?) -> String {
        nonEmpty(project?.defaultDriver) ?? nonEmpty(settings?.defaultDriver) ?? ""
    }

    /// What a ticket's Default resolves to: the project's driver with the model it would inherit there.
    public static func ticketResolvedChoice(_ project: ModelProject?, _ settings: ModelSettings?) -> TriageChoice {
        let driver = projectDriver(project, settings)
        guard !driver.isEmpty else { return Watchers.defaultTriageChoice }
        return TriageChoice(driver: driver, model: inheritedModel(driver, level: .ticket, project: project, settings: settings))
    }

    /// A ticket's pick in the combined select. It always has a driver, so it shows as Default only
    /// when it sits on its project's driver without a model of its own.
    public static func ticketChoice(driver: String, model: String?, _ project: ModelProject?, _ settings: ModelSettings?) -> TriageChoice {
        if nonEmpty(model) == nil, driver == projectDriver(project, settings) { return Watchers.defaultTriageChoice }
        return TriageChoice(driver: driver, model: model)
    }

    public static func ticketChoice(_ ticket: Ticket, _ project: ModelProject?, _ settings: ModelSettings?) -> TriageChoice {
        ticketChoice(driver: ticket.driver, model: ticket.model, project, settings)
    }

    /// The ticket PATCH for a pick (`driver` and `model` set). Default puts it back on the project's
    /// driver with no model of its own.
    public static func ticketChoicePatch(_ choice: TriageChoice, _ project: ModelProject?, _ settings: ModelSettings?) -> UpdateTicketBody {
        let driver = choice.driver ?? projectDriver(project, settings)
        guard !driver.isEmpty else { return UpdateTicketBody(model: .null) }
        return UpdateTicketBody(driver: driver, model: Patch(choice.model))
    }

    /// A project's default pick. A pinned driver shows with its model. Without one, a model stored for
    /// the settings' driver still shows as that pick; otherwise Default (inherit both from settings).
    public static func projectChoice(_ project: ModelProject, _ settings: ModelSettings?) -> TriageChoice {
        if let pinned = nonEmpty(project.defaultDriver) {
            return TriageChoice(driver: pinned, model: nonEmpty(project.defaultModels?[pinned] ?? nil))
        }
        guard let driver = nonEmpty(settings?.defaultDriver), let model = nonEmpty(project.defaultModels?[driver] ?? nil) else {
            return Watchers.defaultTriageChoice
        }
        return TriageChoice(driver: driver, model: model)
    }

    /// The project PATCH for a pick (`defaultDriver` and `defaultModels` set): the driver, and a
    /// models map holding only that driver's model.
    public static func projectChoicePatch(_ choice: TriageChoice, _ project: ModelProject) -> UpdateProjectBody {
        UpdateProjectBody(defaultDriver: Patch(choice.driver), defaultModels: Watchers.replaceModels(project.defaultModels, keep: choice))
    }

    /// Settings' default pick. The driver is always set, so Default means that driver's own default model.
    public static func settingsChoice(_ settings: ModelSettings) -> TriageChoice {
        guard let model = nonEmpty(settings.defaultModels[settings.defaultDriver] ?? nil) else { return Watchers.defaultTriageChoice }
        return TriageChoice(driver: settings.defaultDriver, model: model)
    }

    /// The settings PATCH for a pick (`defaultDriver` and `defaultModels` set). Default keeps the
    /// driver and clears the models.
    public static func settingsChoicePatch(_ choice: TriageChoice, _ settings: ModelSettings) -> SettingsPatch {
        let driver = choice.driver ?? settings.defaultDriver
        return SettingsPatch(
            defaultDriver: driver,
            defaultModels: Watchers.replaceModels(settings.defaultModels, keep: TriageChoice(driver: driver, model: choice.model))
        )
    }

    /// The groups a type-ahead query leaves: every word of the query must appear (case-insensitive) in
    /// the option's label, its model id, or its driver's name, so "claude op" finds Opus under Claude
    /// Code and "gpt" finds gpt-4o by id. Groups with no match are dropped; an empty query keeps all.
    public static func filterChoiceGroups(_ groups: [ChoiceGroup], _ query: String, driverNames: [String: String] = [:]) -> [ChoiceGroup] {
        let words = queryWords(query)
        if words.isEmpty { return groups }
        return groups.compactMap { g in
            let driver = "\(g.label ?? "") \(driverNames[g.driver] ?? "") \(g.driver)"
            let options = g.options.filter { o in
                let hay = Array(Branches.jsLowerCase("\(o.label) \(decodeChoice(o.value).model ?? "") \(driver)").utf16)
                return words.allSatisfy { jsIncludes(hay, $0) }
            }
            guard !options.isEmpty else { return nil }
            var out = g
            out.options = options
            return out
        }
    }

    // MARK: JS string helpers

    /// `query.toLowerCase().split(/\s+/).filter(Boolean)`, each word as UTF-16 code units.
    static func queryWords(_ query: String) -> [[UInt16]] {
        Branches.jsLowerCase(query).unicodeScalars
            .split(whereSeparator: JSCompat.isWhitespace)
            .map { Array(String(String.UnicodeScalarView($0)).utf16) }
    }

    /// `hay.includes(needle)` on UTF-16 code units.
    static func jsIncludes(_ hay: [UInt16], _ needle: [UInt16]) -> Bool {
        if needle.isEmpty { return true }
        guard needle.count <= hay.count else { return false }
        for start in 0...(hay.count - needle.count) where hay[start] == needle[0] {
            if hay[start..<(start + needle.count)].elementsEqual(needle) { return true }
        }
        return false
    }

    /// JS truthiness for an optional string: nil and "" are both unset.
    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}

// MARK: - Shared per-driver cache (one fetch per driver however many selects are mounted)

public struct ModelListState: Sendable, Equatable {
    public var data: DriverModels?
    public var loading: Bool
    /// Request failure (network / unknown driver); driver failures arrive as data.error
    public var error: String?

    public init(data: DriverModels? = nil, loading: Bool = false, error: String? = nil) {
        self.data = data
        self.loading = loading
        self.error = error
    }

    public static let empty = ModelListState()
}

/// The per-driver model list cache. Views read `get(_:)` (Observation tracks it); `load` fetches
/// a driver's list once however many selects ask, and `syncEpoch` drops everything on a reconnect.
/// Replaces the TS `subscribe` listeners with Observation; `version` is kept for callers that want
/// one value that changes whenever any entry does.
@MainActor
@Observable
public final class ModelListCache {
    private var entries: [String: ModelListState] = [:]
    @ObservationIgnored private var inflight: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private let fetchModels: @Sendable (String, Bool) async throws -> DriverModels

    /// Bumped on every change; a stable snapshot for views that read several drivers at once.
    public private(set) var version = 0

    public init(fetch: @escaping @Sendable (String, Bool) async throws -> DriverModels) {
        fetchModels = fetch
    }

    /// The cache for a client (`modelCacheFor`): lists come from GET /drivers/:id/models.
    public convenience init(client: HarnessClient) {
        self.init { id, refresh in try await client.listModels(id, refresh: refresh) }
    }

    public func get(_ driverId: String) -> ModelListState {
        entries[driverId] ?? .empty
    }

    /// Fetch unless already loaded (or loading); refresh forces a service-side re-query.
    public func load(_ driverId: String, refresh: Bool = false) async {
        if driverId.isEmpty { return }
        let cur = get(driverId)
        if !refresh, cur.data != nil || Models.nonEmpty(cur.error) != nil { return }
        if !refresh, let pending = inflight[driverId] {
            await pending.value
            return
        }
        var loading = cur
        loading.loading = true
        set(driverId, loading)
        let fetch = fetchModels
        // The task body can't start before this method suspends (both run on the main actor), so
        // `inflight[driverId] = task` below always lands before the body's own removal.
        let task = Task { @MainActor [weak self] in
            let next: ModelListState
            do {
                next = ModelListState(data: try await fetch(driverId, refresh), loading: false, error: nil)
            } catch {
                next = ModelListState(data: cur.data, loading: false, error: Self.message(error))
            }
            guard let self else { return }
            // Mirrors TS exactly: a request that was in flight when syncEpoch cleared the cache still
            // writes its (possibly stale) result, and its `finally` removes whatever request is in
            // flight for the driver now, even a newer one.
            self.set(driverId, next)
            self.inflight[driverId] = nil
        }
        inflight[driverId] = task
        await task.value
    }

    /// A new connection epoch (reconnect) makes every cached list stale.
    public func syncEpoch(_ epoch: Int) {
        guard epoch > self.epoch else { return }
        self.epoch = epoch
        entries.removeAll()
        inflight.removeAll()
        // TS doesn't emit here (its hooks re-read on the next load); bumping keeps `version` honest
        // as "changes whenever any entry does".
        version += 1
    }

    private func set(_ driverId: String, _ s: ModelListState) {
        entries[driverId] = s
        version += 1
    }

    /// `err instanceof Error ? err.message : String(err)`.
    nonisolated static func message(_ error: any Error) -> String {
        if let e = error as? HarnessAPIError { return e.message }
        if let e = error as? LocalizedError, let d = e.errorDescription { return d }
        return String(describing: error)
    }
}
