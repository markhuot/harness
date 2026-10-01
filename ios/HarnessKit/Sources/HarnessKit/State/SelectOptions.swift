import Foundation

// Port of mobile/src/lib/selectOptions.ts: the option shape for native selects, and the trigger's
// label for a value.

public struct SelectOption: Codable, Sendable, Equatable, Hashable {
    public var value: String
    public var label: String
    /// Second line in the menu (a description)
    public var subtitle: String?
    public var disabled: Bool?

    public init(value: String, label: String, subtitle: String? = nil, disabled: Bool? = nil) {
        self.value = value
        self.label = label
        self.subtitle = subtitle
        self.disabled = disabled
    }
}

public enum SelectOptions {
    /// The trigger's text: the selected option's label, or `fallback` when the value isn't listed.
    public static func selectedLabel(_ options: [SelectOption], value: String, fallback: String) -> String {
        options.first { $0.value == value }?.label ?? fallback
    }
}
