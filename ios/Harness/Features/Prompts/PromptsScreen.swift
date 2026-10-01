import HarnessKit
import SwiftUI

/// Settings → Prompts (screens/Prompts.tsx PromptsScreen): the built-in agent prompts by group,
/// each built-in (follows app updates), customized or broken. Rows push `.prompt(id:)`.
struct PromptsScreen: View {
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @State private var catalog = PromptCatalog()

    var body: some View {
        ZStack {
            if let prompts = catalog.prompts {
                Form {
                    Section {
                        Text(promptsIntro)
                            .font(.system(size: 13))
                            .foregroundStyle(c.text3)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    }
                    ForEach(Prompts.groupPrompts(prompts), id: \.title) { g in
                        Section {
                            ForEach(g.entries) { p in row(p) }
                        } header: {
                            Text(g.title)
                        } footer: {
                            Text(g.description)
                        }
                    }
                }
                .settingsFormStyle(c)
            } else {
                PromptsLoading(error: catalog.error)
            }
        }
        .loadingPrompts(catalog)
        .navigationTitle("Prompts")
    }

    private func row(_ p: PromptEntry) -> some View {
        Button { router.push(.prompt(id: p.id.rawValue)) } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(p.label).font(.system(size: 16)).foregroundStyle(c.text)
                        PromptBadge(entry: p)
                    }
                    Text(p.description).font(.system(size: 13)).foregroundStyle(c.text3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Icon("chevronRight", size: 13).foregroundStyle(c.text3)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .settingsRowBackground(c)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(p.label)
        .accessibilityValue(Prompts.promptState(p).label)
        .accessibilityHint(p.description)
        .accessibilityAddTraits(.isButton)
    }
}
