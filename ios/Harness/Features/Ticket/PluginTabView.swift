import HarnessKit
import SwiftUI

/// FEATURE SLOT (Plugin tabs ticket): a plugin's ticket tab in a WKWebView with the host bridge
/// (screens/PluginTab.tsx, lib/pluginHost). `tab` is the manifest entry the `plugin:<p>:<t>` route
/// names. Replace the body.
struct PluginTabView: View {
    let ticket: Ticket
    let tab: PluginTab

    var body: some View {
        SlotPlaceholder(name: tab.title, params: [("ticket", ticket.key), ("plugin", "\(tab.pluginId):\(tab.id)")])
    }
}
