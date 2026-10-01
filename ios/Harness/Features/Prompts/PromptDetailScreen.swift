import HarnessKit
import SwiftUI

/// FEATURE SLOT (Prompts ticket): one prompt, read-only or customized, with Customize / Reset to
/// built-in (app/prompt/[id].tsx). Replace the body.
struct PromptDetailScreen: View {
    let id: String

    var body: some View {
        SlotPlaceholder(name: "Prompt", params: [("id", id)])
            .navigationBarTitleDisplayMode(.inline)
    }
}
