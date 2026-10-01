import HarnessHighlight
import HarnessKit
import SwiftUI

/// Debug screen: Swift, TypeScript and a diff highlighted in the default light and dark themes,
/// with how long the highlighter took to load and to color its first block. Open it from the root
/// screen in debug builds, or launch with `-debugScreen highlight`.
struct HighlightPreviewView: View {
    @State private var timing: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(timing ?? "Loading highlighter…")
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
                ForEach(ThemeAppearance.allCases, id: \.self) { appearance in
                    if let theme = Themes.find(Themes.defaultThemeId(for: appearance)) {
                        PreviewThemeSection(theme: theme)
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Syntax highlighting")
        .task {
            // Launch to first colored block, whichever block's job ran first.
            let start = ContinuousClock.now
            _ = try? await Highlighter.app.highlight("let warm = 1", language: "swift", theme: "pierre-light", appearance: .light)
            let total = ContinuousClock.now - start
            let t = await Highlighter.app.timings
            timing = "Script load \(ms(t.scriptLoad)) · first highlight \(ms(t.firstHighlight)) · cold start to colors \(ms(total))"
        }
    }

    private func ms(_ d: Duration?) -> String {
        guard let c = d?.components else { return "–" }
        return "\(c.seconds * 1000 + c.attoseconds / 1_000_000_000_000_000) ms"
    }
}

private struct PreviewThemeSection: View {
    let theme: Theme

    var body: some View {
        let syntax = SyntaxTheme.name(theme.appearance, theme.syntaxTheme)
        VStack(alignment: .leading, spacing: 8) {
            Text("\(theme.name) · \(syntax)")
                .font(.headline)
            PreviewCodeBlock(code: Samples.swift, language: "swift", diff: false, theme: theme, syntaxTheme: syntax)
            PreviewCodeBlock(code: Samples.typescript, language: "typescript", diff: false, theme: theme, syntaxTheme: syntax)
            PreviewCodeBlock(code: Samples.diff, language: "diff", diff: true, theme: theme, syntaxTheme: syntax)
        }
        .padding(12)
        .background(theme.tokens.color(.bg), in: .rect(cornerRadius: 12))
        .environment(\.colorScheme, theme.appearance == .dark ? .dark : .light)
    }
}

/// A minimal CodeBlock: plain lines at once (from the cache when it has them), colors when they land.
private struct PreviewCodeBlock: View {
    let code: String
    let language: String
    let diff: Bool
    let theme: Theme
    let syntaxTheme: String

    @State private var result: Highlighted?

    var body: some View {
        let hl = result ?? Highlighter.app.cached(code, language: language, theme: syntaxTheme, diff: diff) ?? nil
        let lines = hl?.lines ?? PlainLines.lines(code, diff: diff)
        let style = HighlightedText.style(hl, tokens: theme.tokens, appearance: theme.appearance)
        let tints = try? HighlightColors.diffTints(theme.tokens.bgSunken, hl?.git ?? HighlightColors.gitColors(nil, theme.appearance), theme.appearance)
        ScrollView(.horizontal) {
            if diff {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(HighlightedText.line(line, style: style))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .background(rowTint(line.kind, tints))
                    }
                }
                .padding(.vertical, 10)
            } else {
                Text(HighlightedText.block(lines, style: style))
                    .padding(10)
            }
        }
        .font(HighlightedText.font)
        .lineSpacing(18 - HighlightedText.fontSize * 1.2)
        .background(theme.tokens.color(.bgSunken), in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.tokens.color(.border), lineWidth: 0.5))
        .task(id: syntaxTheme) {
            let hl = Highlighter.app
            result = diff
                ? try? await hl.highlightDiff(code, language: language, theme: syntaxTheme, appearance: theme.appearance)
                : try? await hl.highlight(code, language: language, theme: syntaxTheme, appearance: theme.appearance)
        }
    }

    private func rowTint(_ kind: HighlightLineKind?, _ tints: DiffTints?) -> Color {
        switch kind {
        case .add: tints.flatMap { Color(css: $0.add) } ?? .clear
        case .del: tints.flatMap { Color(css: $0.del) } ?? .clear
        default: .clear
        }
    }
}

private enum Samples {
    static let swift = """
    /// A point on the board.
    struct Point: Equatable {
        var x = 0.5
        func moved(by d: Double) -> Point { Point(x: x + d) }
    }
    let label = "x is \\(Point().x)" // interpolated
    """

    static let typescript = """
    import { highlight } from "./highlight";
    export async function color(code: string): Promise<number> {
      const r = await highlight(code, "ts", `pierre-${mode}`);
      return r?.lines.length ?? 0; // 0 when plain
    }
    """

    static let diff = """
    diff --git a/src/app.ts b/src/app.ts
    --- a/src/app.ts
    +++ b/src/app.ts
    @@ -1,3 +1,3 @@
     const greeting = "hello";
    -export const n: number = 1;
    +export const n: number = 2;
     console.log(greeting, n);
    """
}

#Preview {
    NavigationStack { HighlightPreviewView() }
}
