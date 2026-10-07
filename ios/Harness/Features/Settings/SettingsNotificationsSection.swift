import HarnessKit
import SwiftUI
import UserNotifications

/// Notifications: whether iOS lets the app show them (with a way to the system's settings when it
/// doesn't), and the service's switches for what it sends: all of it, and each kind of activity.
/// The switches edit the Mac's setting, so they apply to every device it notifies; a service too
/// old to send `notifications` has no switches.
struct SettingsNotificationsSection: View {
    let settings: PublicSettings?

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.openURL) private var openURL
    @Environment(\.palette) private var c

    private var push: PushCenter { PushCenter.shared }

    var body: some View {
        Section {
            SettingsRow(label: "On this \(deviceName)", hint: permissionHint) {
                if needsSystemSettings {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                    }
                    .font(.scaled(size: 15))
                    .foregroundStyle(c.accent)
                } else {
                    Text(permissionLabel).font(.scaled(size: 15)).foregroundStyle(c.text3)
                }
            }
            if let n = settings?.notifications {
                SettingsRow(label: "Send notifications", hint: "When an agent or the service adds activity to a ticket you aren't looking at.") {
                    toggle("Send notifications", on: n.enabled) { save(NotificationSettingsPatch(enabled: $0)) }
                }
                ForEach(NotificationCategory.allKnown, id: \.self) { category in
                    SettingsRow(label: category.label, hint: category.detail) {
                        toggle(category.label, on: n.isOn(category)) { save(.category(category, $0)) }
                            .disabled(!n.enabled)
                    }
                    .opacity(n.enabled ? 1 : 0.5)
                }
            }
        } header: {
            Text("Notifications")
        } footer: {
            if settings?.notifications != nil {
                Text("These switches are on the Mac, so they apply to every device it notifies. How notifications look on this \(deviceName) is up to the system's settings.")
            }
        }
        .task { await push.refreshAuthorization() }
    }

    private var needsSystemSettings: Bool {
        push.authorization == .denied || push.authorization == .notDetermined
    }

    private var permissionLabel: String {
        switch push.authorization {
        case .authorized: "Allowed"
        case .provisional: "Delivered quietly"
        case .ephemeral: "Allowed for now"
        case .denied: "Off"
        default: "Not asked yet"
        }
    }

    private var permissionHint: String? {
        if let error = push.registrationError { return "Couldn't register for notifications: \(error)" }
        switch push.authorization {
        case .denied: return "Notifications are off for Harness. Turn them on in Settings to hear about activity on your tickets."
        case .notDetermined: return "Harness hasn't been allowed to show notifications yet."
        default: return nil
        }
    }

    private func toggle(_ label: String, on: Bool, set: @escaping (Bool) -> Void) -> some View {
        Toggle(label, isOn: Binding(get: { on }, set: set))
            .labelsHidden()
            .tint(c.accent)
            .accessibilityLabel(label)
    }

    private func save(_ patch: NotificationSettingsPatch) {
        guard let api = store.api else { return }
        actions.perform { _ = try await api.updateSettings(SettingsPatch(notifications: patch)) }
    }
}
