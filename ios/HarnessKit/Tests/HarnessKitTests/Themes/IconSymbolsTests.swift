import Testing
@testable import HarnessKit

@Suite("Icon symbols")
struct IconSymbolsTests {
    /// A name added to shared/src/state/icons.ts without a symbol here would draw the fallback.
    @Test func everySharedIconHasASymbol() {
        let missing = Icons.names.filter { Icons.symbols[$0] == nil }
        #expect(missing.isEmpty, "no SF Symbol for \(missing)")
        let stale = Icons.symbols.keys.filter { !Icons.isIconName($0) }
        #expect(stale.isEmpty, "symbols for names icons.ts doesn't have: \(stale)")
    }

    @Test func unknownNamesFallBack() {
        #expect(Icons.symbol("definitely-not-an-icon") == Icons.fallbackSymbol)
        #expect(Icons.symbol("board") == "rectangle.split.3x1")
    }
}
