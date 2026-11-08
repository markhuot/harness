import Testing
import HarnessKit

/// Markdown.html writes the same clipboard HTML as shared/src/state/markdownHtml.ts
/// (testing/l0/state/markdownHtml.test.ts holds the same cases).
@Suite struct MarkdownHtmlTests {
    @Test func headingsParagraphsRulesAndCode() {
        #expect(Markdown.html("## Goal\n\nline one\nline two\n\n---\n\n```ts\nconst a = 1 < 2;\n```")
            == "<h2>Goal</h2><p>line one<br>line two</p><hr><pre><code>const a = 1 &lt; 2;</code></pre>")
    }

    @Test func textAndCodeAreEscaped() {
        #expect(Markdown.html("<script>alert(\"x\")</script> & `<b>`")
            == "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; <code>&lt;b&gt;</code></p>")
    }

    @Test func onlyWebLinksStayLinks() {
        #expect(Markdown.html("**bold** *it* [site](https://x.dev/?a=1&b=2) [a.ts:3](harness://file/a.ts#L3) [FOO-1](WEB-2) HARNESS-5 ![shot](attachment:abc.png)")
            == "<p><strong>bold</strong> <em>it</em> <a href=\"https://x.dev/?a=1&amp;b=2\">site</a> a.ts:3 FOO-1 HARNESS-5 <em>shot</em></p>")
    }

    @Test func nestedListsTasksAndQuestions() {
        #expect(Markdown.html("3. three\n4. four\n   - [ ] open\n   - [x] done\n\n- ( ) ask?\n- (x) asked")
            == "<ol start=\"3\"><li>three</li><li>four<ul><li>☐ open</li><li>☑ done</li></ul></li></ol><ul><li>☐ ask?</li><li>☑ asked</li></ul>")
    }

    @Test func tablesAndQuotes() {
        #expect(Markdown.html("| a | b |\n|:-:|---|\n| 1 | **2** |\n\n> one\n> two")
            == "<table><thead><tr><th style=\"text-align:center\">a</th><th>b</th></tr></thead><tbody><tr><td style=\"text-align:center\">1</td><td><strong>2</strong></td></tr></tbody></table><blockquote><p>one<br>two</p></blockquote>")
    }

    @Test func attachmentsBecomeTheirAltText() {
        #expect(Markdown.html("![After](attachment:a.png)\n\n![Before](attachment:b.png \"thumb\") ![](attachment:c.png \"thumb\")\n\n![](attachment:d.png)")
            == "<p><em>After</em></p><p><em>Before</em></p>")
    }

    @Test func attachmentLinksBecomeTheirText() {
        #expect(Markdown.html("[Flame graph](attachment:a1)\n\nsee [the <graph>](attachment:b1)")
            == "<p><em>Flame graph</em></p><p>see the &lt;graph&gt;</p>")
    }
}
