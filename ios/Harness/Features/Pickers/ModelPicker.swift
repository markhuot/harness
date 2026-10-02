import HarnessKit
import SwiftUI

/// One driver's model (on Models.modelOptions). nil value = Default
/// (`inherited` names what that is). The list comes from the shared per-driver cache; a failed
/// list shows a warning on the trigger and its reason above "Refresh model list".
struct ModelPicker: View {
    let driver: String
    let value: String?
    var inherited: String?
    var defaultLabel: String?
    var plainDefault = false
    var title = "Model"
    var disabled = false
    let onChange: (String?) -> Void

    @Environment(BoardStore.self) private var store

    var body: some View {
        let cache = store.sharedModelCache
        let list = cache.get(driver)
        let options = Models.modelOptions(list.data?.models, value: value, .init(inherited: inherited, defaultLabel: defaultLabel, plainDefault: plainDefault))
            .map { PickerOption(value: $0.value, label: $0.label) }
        let problem = PickerLogic.modelListProblem(list)
        SelectMenu(
            value: value ?? "",
            options: options,
            title: title,
            actions: [SelectMenuAction(label: "Refresh model list", systemImage: "arrow.clockwise") { Task { await cache.load(driver, refresh: true) } }],
            disabled: disabled || driver.isEmpty,
            loading: list.loading && list.data == nil,
            problem: problem.map { "Couldn't list models: \($0)" },
            accessibilityName: title
        ) { onChange($0.isEmpty ? nil : $0) }
        .task(id: "\(driver)#\(store.epoch)") {
            cache.syncEpoch(store.epoch)
            await cache.load(driver)
        }
    }
}
