import Foundation

// Port of mobile/src/lib/modelSheet.ts. Rows for the searchable Model sheet (the combined driver +
// model picker): the Default option (when offered), then one section per driver, narrowed by the
// type-ahead query.

public struct ChoiceSection: Codable, Sendable, Equatable, Identifiable {
    public var key: String
    /// Driver name heading; null → no header (the Default row, or a single driver's flat list)
    @Nullable public var title: String?
    public var data: [ModelOption]

    public var id: String { key }

    public init(key: String, title: String?, data: [ModelOption]) {
        self.key = key
        self.title = title
        self.data = data
    }
}

public enum ModelSheet {
    /// Sections for the sheet. With no query everything shows, Default first. While a query is
    /// typed, drivers and models are filtered by the shared type-ahead and Default only stays when its
    /// own label matches every word. An empty result means "No models match".
    public static func choiceSections(default def: ModelOption?, groups: [ChoiceGroup], query: String, driverNames: [String: String] = [:]) -> [ChoiceSection] {
        let words = Models.queryWords(query)
        var out: [ChoiceSection] = []
        if let def {
            let label = Array(Branches.jsLowerCase(def.label).utf16)
            if words.isEmpty || words.allSatisfy({ Models.jsIncludes(label, $0) }) {
                out.append(ChoiceSection(key: "", title: nil, data: [def]))
            }
        }
        for g in Models.filterChoiceGroups(groups, query, driverNames: driverNames) {
            out.append(ChoiceSection(key: g.driver, title: g.label, data: g.options))
        }
        return out
    }

    public static func choiceSections(_ choices: ChoiceOptions, query: String, driverNames: [String: String] = [:]) -> [ChoiceSection] {
        choiceSections(default: choices.default, groups: choices.groups, query: query, driverNames: driverNames)
    }
}
