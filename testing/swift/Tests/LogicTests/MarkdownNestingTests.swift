import Testing
import HarnessKit

/// The Swift parser reads blocks under a list item the way shared/src/state/markdown.ts does.
@Suite struct MarkdownNestingTests {
    private static func kinds(_ blocks: [Markdown.Block]) -> [String] {
        blocks.map {
            switch $0 {
            case .p: "p"
            case .h: "h"
            case .ul: "ul"
            case .ol: "ol"
            case .code: "code"
            case .quote: "quote"
            case .table: "table"
            case .hr: "hr"
            case .img: "img"
            case .thumbs: "thumbs"
            }
        }
    }

    private static func firstItem(_ src: String) -> Markdown.ListItem? {
        guard case let .ul(items)? = Markdown.parseBlocks(src).first else { return nil }
        return items.first
    }

    @Test func aTableUnderAnItemIsItsChild() throws {
        for src in ["- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |", "- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |"] {
            let item = try #require(Self.firstItem(src))
            #expect(item.text == "item")
            #expect(Self.kinds(item.children) == ["table"])
        }
    }

    @Test func aHeadingQuoteAndRuleUnderAnItemAreChildren() throws {
        let item = try #require(Self.firstItem("- item\n  ## Head\n\n  > said\n\n  ---"))
        #expect(item.text == "item")
        #expect(Self.kinds(item.children) == ["h", "quote", "hr"])
    }

    @Test func continuationTextStillJoinsTheItem() throws {
        let item = try #require(Self.firstItem("- a\n  more\n  words"))
        #expect(item.text == "a more words")
        #expect(item.children.isEmpty)
    }

    @Test func aQuoteHoldsMarkdownToParseAgain() throws {
        guard case let .quote(text)? = Markdown.parseBlocks("> # Head\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |").first else {
            Issue.record("no quote")
            return
        }
        #expect(Self.kinds(Markdown.parseBlocks(text)) == ["h", "table"])
    }
}
