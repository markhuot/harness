import HarnessKit
import SwiftUI

/// One control picking a driver and model together (ui/DriverModelPicker.tsx on
/// Models.driverModelChoices): watchers, the Triage default, New session, ticket details, and the
/// project and app default models. A Menu can't search, so the trigger looks like the other
/// selects but opens a page sheet: a type-ahead field over Default first, then each signed-in
/// driver's models under its heading (one flat list when only one driver shows).
///
/// `resolved` is what Default falls back to; `onlyDriver` lists one driver's models (a ticket
/// mid-run keeps its driver); `inheritedModel` names what a driver without a model falls back to.
struct DriverModelPicker: View {
    let value: Watchers.TriageChoice
    let resolved: Watchers.TriageChoice
    var title = "Model"
    var defaultLabel: String?
    var onlyDriver: String?
    var disabled = false
    var inheritedModel: ((String) -> String?)?
    let onChange: (Watchers.TriageChoice) -> Void

    @Environment(BoardStore.self) private var store
    @State private var open = false

    var body: some View {
        let cache = store.sharedModelCache
        let drivers = store.state.drivers
        let ids = PickerLogic.choiceDriverIds(drivers, value: value, resolved: resolved, onlyDriver: onlyDriver)
        let names = Dictionary(drivers.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        let lists = Dictionary(ids.map { ($0, cache.get($0)) }, uniquingKeysWith: { a, _ in a })
        let status = PickerLogic.choiceListsStatus(ids, lists: { lists[$0] ?? .empty }, name: { names[$0] ?? $0 })
        let choices = choices(cache: cache, ids: ids, drivers: drivers)
        Button {
            open = true
        } label: {
            SelectTrigger(text: choices.selectedLabel, disabled: disabled, loading: status.loading, problem: status.problem != nil)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(choices.selectedLabel)")
        .accessibilityAddTraits(.isButton)
        .task(id: "\(ids.joined(separator: ","))#\(store.epoch)") {
            cache.syncEpoch(store.epoch)
            await withTaskGroup(of: Void.self) { group in
                for id in ids { group.addTask { await cache.load(id) } }
            }
        }
        .sheet(isPresented: $open) {
            DriverModelSheet(
                title: title,
                choices: choices,
                picked: Models.encodeChoice(value),
                loading: status.loading,
                problem: status.problem,
                driverNames: names,
                onRefresh: { for id in ids { Task { await cache.load(id, refresh: true) } } },
                onPick: { v in
                    haptic(.select)
                    open = false
                    if v != Models.encodeChoice(value) { onChange(Models.decodeChoice(v)) }
                }
            )
        }
    }

    private func choices(cache: ModelListCache, ids: [String], drivers: [DriverInfo]) -> ChoiceOptions {
        var models: [String: [ModelInfo]] = [:]
        for id in ids { if let list = cache.get(id).data?.models { models[id] = list } }
        // driverModelChoices wants a Sendable lookup: resolve every driver it can ask about up front.
        var lookup: (@Sendable (String) -> String?)?
        if let inheritedModel {
            var map: [String: String] = [:]
            for id in ids + drivers.map(\.id) { if let m = inheritedModel(id) { map[id] = m } }
            let resolvedMap = map
            lookup = { resolvedMap[$0] }
        }
        let options = Models.DriverModelChoicesOptions(defaultLabel: defaultLabel, onlyDriver: onlyDriver, inheritedModel: lookup)
        return Models.driverModelChoices(drivers.map(ChoiceDriver.init), models: models, value: value, resolved: resolved, options)
    }
}

/// The searchable sheet: Default first, then a section per driver, the check on the current pick.
private struct DriverModelSheet: View {
    let title: String
    let choices: ChoiceOptions
    let picked: String
    let loading: Bool
    let problem: String?
    let driverNames: [String: String]
    let onRefresh: () -> Void
    let onPick: (String) -> Void

    @State private var query = ""
    @Environment(\.palette) private var c

    var body: some View {
        let sections = ModelSheet.choiceSections(choices, query: query, driverNames: driverNames)
        PickerSheet(title: title, query: $query, placeholder: "Search models", searchLabel: "Search models", problem: problem) {
            if loading {
                ProgressView()
            } else {
                Button("Refresh model lists", systemImage: "arrow.clockwise", action: onRefresh)
            }
        } content: {
            List {
                ForEach(sections) { section in
                    Section {
                        ForEach(section.data, id: \.value) { option in
                            PickerSheetRow(
                                label: option.label,
                                selected: option.value == picked,
                                accessibilityLabel: PickerLogic.choiceRowLabel(section: section.title, label: option.label),
                                action: { onPick(option.value) },
                                leading: { EmptyView() },
                                subtitle: { EmptyView() }
                            )
                        }
                    } header: {
                        if let heading = section.title { Text(heading) }
                    }
                }
            }
            .overlay {
                if sections.isEmpty {
                    Text("No models match").font(.system(size: 15)).foregroundStyle(c.text3)
                }
            }
        }
    }
}
