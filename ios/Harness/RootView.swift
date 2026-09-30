import HarnessKit
import SwiftUI

/// Placeholder root until the server list and board land: proves the app launches and links HarnessKit.
struct RootView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Harness", systemImage: "rectangle.3.group")
            } description: {
                Text("Native app scaffold. HarnessKit client: \(HarnessKit.clientName)")
            }
            .navigationTitle("Harness")
        }
    }
}

#Preview {
    RootView()
}
