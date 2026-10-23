import HarnessKit
import SwiftUI

/// One switch per board column: the columns whose tickets' events reach a chief of staff. Blocked
/// also lets a chief answer blocked tickets itself. `disabled` greys them while a project inherits.
struct CosStatusRows: View {
    let statuses: [TicketStatus]
    var disabled = false
    let save: ([TicketStatus]) -> Void

    @Environment(\.palette) private var c

    var body: some View {
        ForEach(TicketStatus.allKnown, id: \.rawValue) { status in
            let label = Format.statusLabel[status] ?? status.rawValue
            SettingsRow(label: "CoS handles \(label)") {
                Toggle("CoS handles \(label)", isOn: Binding(
                    get: { statuses.contains(status) },
                    set: { save(CosSettings.toggled(status, on: $0, in: statuses)) }
                ))
                .labelsHidden()
                .tint(c.accent)
                .disabled(disabled)
                .accessibilityLabel("CoS handles \(label)")
            }
        }
    }
}

enum CosStatusCopy {
    static let hint = "Events on tickets in a checked column reach a chief of staff; unchecked columns are left alone. Checking Blocked also lets a chief answer blocked tickets itself."
}
