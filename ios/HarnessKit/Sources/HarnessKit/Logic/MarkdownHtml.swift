// Markdown as plain HTML for the clipboard: what the Spec tab's "Copy spec" puts beside the raw
// markdown, so a paste into a rich editor keeps headings, lists, tables and emphasis while "Paste and
// Match Style" gets the markdown. A port of shared/src/state/markdownHtml.ts, with the same output:
// built from parseBlocks / inlineTokens, every piece of text escaped.
//
// What only Harness can show becomes text: an attachment is its alt text in italics, a ticket key is
// its label, a file link is its label; only http(s) links stay links. A task item or question leads
// with ☐ (open) or ☑ (done).

import Foundation

extension Markdown {
    /// `md` as an HTML fragment (no <html> or <body>), for the clipboard's public.html.
    public static func html(_ md: String) -> String {
        HtmlWriter.blocks(parseBlocks(md))
    }

    public static func escapeHtml(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }
}

private enum HtmlWriter {
    static let esc = Markdown.escapeHtml

    static func inline(_ text: String) -> String {
        Markdown.inlineTokens(text).map { tok -> String in
            switch tok {
            case let .text(s): esc(s)
            case let .code(s): "<code>\(esc(s))</code>"
            case let .strong(s): "<strong>\(esc(s))</strong>"
            case let .em(s): "<em>\(esc(s))</em>"
            case let .link(text, url):
                url.hasPrefix("http:") || url.hasPrefix("https:") ? "<a href=\"\(esc(url))\">\(esc(text))</a>" : esc(text)
            case let .ticket(key, text): esc(text ?? key)
            case let .attach(text, _): esc(text)
            case let .img(m): m.alt.isEmpty ? "" : "<em>\(esc(m.alt))</em>"
            }
        }.joined()
    }

    /// Text whose lines each read as inline markup, kept on their own lines.
    static func lines(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { inline(String($0)) }.joined(separator: "<br>")
    }

    static func item(_ it: Markdown.ListItem) -> String {
        let box = it.checked.map { $0 ? "☑ " : "☐ " } ?? ""
        return "<li>\(box)\(lines(it.text))\(blocks(it.children))</li>"
    }

    static func block(_ b: Markdown.Block) -> String {
        switch b {
        case let .p(text):
            return "<p>\(lines(text))</p>"
        case let .h(level, text):
            return "<h\(level)>\(inline(text))</h\(level)>"
        case let .ul(items):
            return "<ul>\(items.map(item).joined())</ul>"
        case let .ol(start, items):
            return "<ol\(start == 1 ? "" : " start=\"\(start)\"")>\(items.map(item).joined())</ol>"
        case let .code(_, text):
            return "<pre><code>\(esc(text))</code></pre>"
        case let .quote(text):
            return "<blockquote><p>\(lines(text))</p></blockquote>"
        case .hr:
            return "<hr>"
        case let .table(align, header, rows):
            func cell(_ tag: String, _ text: String, _ k: Int) -> String {
                let a = k < align.count ? align[k] : nil
                return "<\(tag)\(a.map { " style=\"text-align:\($0.rawValue)\"" } ?? "")>\(inline(text))</\(tag)>"
            }
            let head = "<thead><tr>\(header.enumerated().map { cell("th", $1, $0) }.joined())</tr></thead>"
            let body = rows.isEmpty ? "" : "<tbody>\(rows.map { r in "<tr>\(r.enumerated().map { cell("td", $1, $0) }.joined())</tr>" }.joined())</tbody>"
            return "<table>\(head)\(body)</table>"
        case let .img(m):
            return m.alt.isEmpty ? "" : "<p><em>\(esc(m.alt))</em></p>"
        case let .thumbs(items):
            let alts = items.map(\.alt).filter { !$0.isEmpty }
            return alts.isEmpty ? "" : "<p>\(alts.map { "<em>\(esc($0))</em>" }.joined(separator: " "))</p>"
        case let .attach(text, _):
            return "<p><em>\(esc(text))</em></p>"
        }
    }

    static func blocks(_ list: [Markdown.Block]) -> String {
        list.map(block).joined()
    }
}
