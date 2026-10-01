import HarnessKit
import SafariServices
import SwiftUI

// Shared by Settings, Project settings, the watcher form and Prompts (ui/settings.tsx's Group and
// SRow, as Form idioms).

extension BoardStore {
    /// The store's client as the full HarnessClient, for the calls that aren't on BoardClient
    /// (settings, network, prompts, watchers, projects).
    var settingsAPI: HarnessClient? { client as? HarnessClient }
}

extension View {
    /// A Form row drawn in the theme's elevated color.
    func settingsRowBackground(_ c: Palette) -> some View { listRowBackground(c.bgElev) }

    /// A Form drawn on the theme's background.
    func settingsFormStyle(_ c: Palette) -> some View {
        scrollContentBackground(.hidden).background(c.bg)
    }
}

/// A tappable Form row (RN SRow with onPress): title, an optional subtitle and a trailing view,
/// the whole row hit-testable. `accessibilityLabel` replaces the merged label when given.
struct SettingsButtonRow<Title: View, Subtitle: View, Trailing: View>: View {
    var chevron = false
    var accessibilityLabel: String?
    let action: () -> Void
    @ViewBuilder var title: Title
    @ViewBuilder var subtitle: Subtitle
    @ViewBuilder var trailing: Trailing

    @Environment(\.palette) private var c

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    title
                    subtitle
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                trailing
                if chevron { Icon("chevronRight", size: 13).foregroundStyle(c.text3) }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .settingsRowBackground(c)
        .modifier(SettingsOptionalLabel(label: accessibilityLabel))
    }
}

private struct SettingsOptionalLabel: ViewModifier {
    let label: String?
    func body(content: Content) -> some View {
        if let label {
            content.accessibilityElement(children: .ignore).accessibilityLabel(label).accessibilityAddTraits(.isButton)
        } else {
            content
        }
    }
}

/// A Section header with a trailing icon button (RN Group's `right`): "Refresh drivers",
/// "Add watcher", "Add project".
struct SettingsSectionHeader: View {
    let title: String
    let icon: String
    let label: String
    var loading = false
    let action: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            if loading {
                ProgressView().controlSize(.small)
            } else {
                Button(action: action) {
                    Icon(icon, size: 16, weight: .semibold).foregroundStyle(c.accent).frame(width: 34, height: 26).contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(label)
            }
        }
    }
}

/// A login page in an in-app Safari sheet (expo-web-browser's openBrowserAsync).
struct SettingsSafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}

/// A URL the Safari sheet can show (http and https only); anything else opens in the system.
struct SettingsWebPage: Identifiable {
    let url: URL
    let message: String?
    var id: String { url.absoluteString }

    static func canShow(_ url: URL) -> Bool { ["http", "https"].contains(url.scheme?.lowercased() ?? "") }
}
