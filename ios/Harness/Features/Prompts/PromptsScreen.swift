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
                // A plain stack, not a lazy Form: every row is in the accessibility tree from the
                // start, as in RN's ScrollView (sim-check waits for a row below the fold).
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        Text(promptsIntro).font(.system(size: 13)).foregroundStyle(c.text3).padding(.horizontal, 16)
                        ForEach(Prompts.groupPrompts(prompts), id: \.title) { g in
                            VStack(alignment: .leading, spacing: 8) {
                                SectionTitle(g.title).padding(.horizontal, 4)
                                Card {
                                    ForEach(Array(g.entries.enumerated()), id: \.element.id) { i, p in
                                        if i > 0 { Divider().overlay(c.border) }
                                        row(p)
                                    }
                                }
                                Text(g.description).font(.system(size: 13)).foregroundStyle(c.text3).padding(.horizontal, 16)
                            }
                        }
                    }
                    .padding(16)
                    .padding(.bottom, 40)
                }
                .background(c.bg)
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
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(p.label)
        .accessibilityValue(Prompts.promptState(p).label)
        .accessibilityHint(p.description)
        .accessibilityAddTraits(.isButton)
    }
}
