import Testing
import HarnessKit

/// Attachment links parse as in shared/src/state/markdown.ts (testing/l0/state/markdown.test.ts,
/// "parseBlocks: attachment links", holds the same cases).
@Suite struct MarkdownAttachTests {
    @Test func aLinkAloneOnItsLineIsAnAttachBlock() {
        #expect(Markdown.parseBlocks("intro\n  [Flame graph](attachment:ab12)  \nafter")
            == [.p(text: "intro"), .attach(text: "Flame graph", id: "ab12"), .p(text: "after")])
    }

    @Test func otherLinkLinesStayParagraphs() {
        for md in ["see [graph](attachment:ab12)", "[site](https://x.dev/a.html)", "[a.html](harness://file/a.html)", "[x](attachment:../etc)", "[x](attachment:.x)"] {
            guard case .p? = Markdown.parseBlocks(md).first else {
                Issue.record("\(md) should be a paragraph")
                continue
            }
        }
    }

    @Test func underAListItemItIsAChild() {
        #expect(Markdown.parseBlocks("- item\n  [Report](attachment:r1)")
            == [.ul(items: [Markdown.ListItem(text: "item", children: [.attach(text: "Report", id: "r1")])])])
    }

    @Test func insideALineItIsAnAttachToken() {
        #expect(Markdown.inlineTokens("open [the graph](attachment:ab12) now")
            == [.text("open "), .attach(text: "the graph", id: "ab12"), .text(" now")])
        #expect(Markdown.inlineTokens("**see [g](attachment:a1)**") == [.strong("see "), .attach(text: "g", id: "a1")])
    }

    @Test func attachmentLinksArentMedia() {
        #expect(Markdown.mediaIn(Markdown.parseBlocks("[g](attachment:a1)\n\ntext [h](attachment:b1)")).isEmpty)
    }
}
