import HarnessKit
import SwiftUI

/// Placeholder root until the server list and board land: proves the app launches and links HarnessKit.
struct RootView: View {
    #if DEBUG
    /// `-debugScreen highlight` on the launch command line opens a debug screen directly.
    @AppStorage("debugScreen") private var debugScreen = ""
    #endif

    var body: some View {
        NavigationStack {
            #if DEBUG
            if debugScreen == "highlight" {
                HighlightPreviewView()
            } else {
                placeholder
            }
            #else
            placeholder
            #endif
        }
    }

    private var placeholder: some View {
        ContentUnavailableView {
            Label("Harness", systemImage: "rectangle.3.group")
        } description: {
            Text("Native app scaffold. HarnessKit client: \(HarnessKit.clientName), \(Themes.all.count) bundled themes")
        } actions: {
            #if DEBUG
            NavigationLink("Syntax highlighting") { HighlightPreviewView() }
            #endif
        }
        .navigationTitle("Harness")
    }
}

#Preview {
    RootView()
}
