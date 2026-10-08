import HarnessKit
import SwiftUI

/// The per-phase driver + model pick (ticket settings, project settings, app settings), on
/// Models.phaseMatrix. The trigger shows the summary ("Opus 5.5 · Complete: Haiku 5.5") and opens
/// a page sheet: a search field over the rows (Inherit first, absent at app level, then each
/// signed-in driver's models under its heading, a "Default (…)" row first) and a radio column per
/// phase (Planning, Work, Review, Complete), one radio selected per column. Tapping a radio sends
/// that phase's patch right away and leaves the sheet open for the next one.
///
/// `inherited` is what each phase resolves to one level up (Phases.inheritedPhaseModels); nil at
/// app level.
struct PhaseModelPicker: View {
    let value: PhaseModels?
    let inherited: PerPhase<PhaseChoice>?
    var title = "Models"
    var disabled = false
    let onChange: (PhaseModelsPatch) -> Void

    @Environment(BoardStore.self) private var store
    @State private var open = false

    var body: some View {
        let cache = store.sharedModelCache
        let drivers = store.state.drivers
        let ids = PickerLogic.phaseDriverIds(drivers, value: value, inherited: inherited)
        let names = Dictionary(drivers.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        let lists = Dictionary(ids.map { ($0, cache.get($0)) }, uniquingKeysWith: { a, _ in a })
        let status = PickerLogic.choiceListsStatus(ids, lists: { lists[$0] ?? .empty }, name: { names[$0] ?? $0 })
        var models: [String: [ModelInfo]] = [:]
        for (id, list) in lists { if let m = list.data?.models { models[id] = m } }
        let matrix = Models.phaseMatrix(drivers.map(ChoiceDriver.init), models: models, value: value, inherited: inherited)
        return Button {
            open = true
        } label: {
            SelectTrigger(text: matrix.summary, disabled: disabled, loading: status.loading, problem: status.problem != nil)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(matrix.summary)")
        .accessibilityAddTraits(.isButton)
        .task(id: "\(ids.joined(separator: ","))#\(store.epoch)") {
            cache.syncEpoch(store.epoch)
            await withTaskGroup(of: Void.self) { group in
                for id in ids { group.addTask { await cache.load(id) } }
            }
        }
        .sheet(isPresented: $open) {
            PhaseModelSheet(
                title: title,
                matrix: matrix,
                loading: status.loading,
                problem: status.problem,
                onRefresh: { for id in ids { Task { await cache.load(id, refresh: true) } } },
                onPick: { phase, row in
                    guard matrix.selected[phase] != row.key else { return }
                    haptic(.select)
                    onChange(Models.phasePickPatch(phase, choice: row.choice))
                }
            )
        }
    }
}

/// The sheet: the column headings pinned under the search field, then the Inherit row and a section
/// per driver, each row with a radio per phase.
private struct PhaseModelSheet: View {
    let title: String
    let matrix: PhaseMatrix
    let loading: Bool
    let problem: String?
    let onRefresh: () -> Void
    let onPick: (Phase, PhaseRow) -> Void

    @State private var query = ""
    @Environment(\.palette) private var c

    static let columnWidth: CGFloat = 58

    var body: some View {
        let groups = Models.filterPhaseGroups(matrix.groups, query)
        let inherit = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? matrix.inherit : nil
        PickerSheet(title: title, query: $query, placeholder: "Search models", searchLabel: "Search models", problem: problem) {
            if loading {
                ProgressView()
            } else {
                Button("Refresh model lists", systemImage: "arrow.clockwise", action: onRefresh)
            }
        } content: {
            VStack(spacing: 0) {
                columnHeadings
                List {
                    if let inherit {
                        Section {
                            row(inherit, group: nil)
                        }
                    }
                    ForEach(groups) { group in
                        Section {
                            ForEach(group.rows) { r in row(r, group: group.label) }
                        } header: {
                            Text(group.label)
                        }
                    }
                }
                .overlay {
                    if groups.isEmpty && inherit == nil {
                        Text("No models match").font(.scaled(size: 15)).foregroundStyle(c.text3)
                    }
                }
            }
        }
    }

    /// Planning, Work, Review, Complete over the radio columns.
    private var columnHeadings: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            ForEach(Phase.allCases, id: \.self) { p in
                Text(p.label)
                    .font(.scaled(size: 11.5, weight: .semibold))
                    .foregroundStyle(c.text2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(width: Self.columnWidth)
            }
        }
        // Lines the headings up with the radios inside the inset-grouped rows (the List's 16pt
        // margin plus the row's 4pt trailing inset).
        .padding(.leading, 36)
        .padding(.trailing, 20)
        .padding(.vertical, 8)
        .accessibilityHidden(true)
    }

    private func row(_ r: PhaseRow, group: String?) -> some View {
        HStack(spacing: 0) {
            Text(r.label)
                .font(.scaled(size: 15))
                .foregroundStyle(c.text)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Phase.allCases, id: \.self) { p in
                let selected = matrix.selected[p] == r.key
                Button {
                    onPick(p, r)
                } label: {
                    Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                        .font(.system(size: 20))
                        .foregroundStyle(selected ? c.accent : c.text3)
                        .frame(width: Self.columnWidth, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(p.label), \(PickerLogic.choiceRowLabel(section: group, label: r.label))")
                .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            }
        }
        .listRowBackground(c.bgElev)
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 4))
    }
}
