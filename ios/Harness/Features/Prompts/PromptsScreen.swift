import HarnessKit
import SwiftUI

/// FEATURE SLOT (Prompts ticket): the prompt list (screens/Prompts.tsx). Rows push
/// `.prompt(id:)`. Replace the body.
struct PromptsScreen: View {
    var body: some View {
        SlotPlaceholder(name: "Prompts")
            .navigationTitle("Prompts")
    }
}
