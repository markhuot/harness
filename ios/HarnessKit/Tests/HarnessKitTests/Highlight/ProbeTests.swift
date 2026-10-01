import Foundation
import HarnessHighlight
import Testing
@Test func probe() async throws {
    let hl = Highlighter(scriptURL: try HighlighterScript.url.get())
    let r = try await hl.highlight("let n = 42; // trailing", language: "typescript", theme: "pierre-light", appearance: .light)
    print("PROBE", r!.lines[0].spans.suffix(2))
    let r2 = try await hl.highlight("let n = 42; // trailing\n", language: "typescript", theme: "pierre-light", appearance: .light)
    print("PROBE2", r2!.lines[0].spans.suffix(2))
}
