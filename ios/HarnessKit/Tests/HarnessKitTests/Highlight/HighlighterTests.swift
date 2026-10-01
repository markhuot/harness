import Foundation
import HarnessHighlight
import HarnessKit
import Testing

// Fixtures/highlight.json comes from the RN app's real highlight() (shared/fixtures/cases/highlight.ts).
// These tests run the same inputs through the JavaScriptCore bundle and the Swift ports.

struct HighlightInput: Decodable, Sendable {
    let code: String?
    let `repeat`: String?
    let times: Int?
    let lang: String?
    let theme: String
    let diff: Bool
    let appearance: ThemeAppearance

    var source: String { code ?? String(repeating: `repeat` ?? "", count: times ?? 0) }
}

/// One highlighter for the suite, so jobs from parallel tests share its queue as an app's would.
private let shared = Highlighter(scriptURL: try! HighlighterScript.url.get())

@Suite("Highlighter (JavaScriptCore) matches highlight.ts")
struct HighlighterParityTests {
    @Test(arguments: Fixture.cases("highlight", "highlightCases", input: HighlightInput.self, output: Highlighted?.self))
    func highlight(_ c: Fixture.Case<HighlightInput, Highlighted?>) async throws {
        let i = c.input
        let got = i.diff
            ? try await shared.highlightDiff(i.source, language: i.lang, theme: i.theme, appearance: i.appearance)
            : try await shared.highlight(i.source, language: i.lang, theme: i.theme, appearance: i.appearance)
        #expect(got == c.output)
        // On a mismatch, name the first line that differs instead of dumping both results.
        if let got, let want = c.output, got != want {
            for (n, (g, w)) in zip(got.lines, want.lines).enumerated() where g != w {
                Issue.record("line \(n + 1): got \(g.spans) want \(w.spans)")
                break
            }
        }
    }

    @Test func bundledLanguagesAndThemesAreHighlightTsLists() async throws {
        #expect(try await shared.languages() == Fixture.value("highlight", "languages", as: [String].self))
        #expect(try await shared.themes() == Fixture.value("highlight", "syntaxThemes", as: [String].self))
        #expect(Highlighter.maxChars == (try Fixture.value("highlight", "maxChars", as: Int.self)))
    }

    @Test func everyAppThemesSyntaxThemeIsBundled() async throws {
        let bundled = Set(try await shared.themes())
        let missing = Themes.all.compactMap(\.syntaxTheme).filter { !bundled.contains($0) }
        #expect(missing.isEmpty)
        #expect(bundled.isSuperset(of: [SyntaxTheme.pierreDefault.light, SyntaxTheme.pierreDefault.dark]))
    }

    @Test func everyBundledLanguageColorsCode() async throws {
        let langs = try await shared.languages().filter { $0 != "diff" }
        for lang in langs {
            let r = try await shared.highlight("x = 1 // \(lang)", language: lang, theme: "pierre-light", appearance: .light)
            #expect(r != nil, "\(lang)")
        }
    }

    @Test func sizeLimitCountsUTF16UnitsLikeJS() async throws {
        // 30 000 emoji are 30 000 Characters but 60 000 UTF-16 units: exactly at the limit.
        let at = String(repeating: "😀", count: Highlighter.maxChars / 2)
        let over = at + "a"
        let hl = Highlighter(scriptURL: try HighlighterScript.url.get())
        #expect(try await hl.highlight(at, language: "markdown", theme: "pierre-light", appearance: .light) != nil)
        #expect(try await hl.highlight(over, language: "markdown", theme: "pierre-light", appearance: .light) == nil)
    }
}

@Suite("Highlighter jobs, cache and failures")
struct HighlighterBehaviorTests {
    @Test func resultsAreCachedPerInputIncludingPlainOnes() async throws {
        let hl = Highlighter(scriptURL: try HighlighterScript.url.get())
        #expect(hl.cached("let memo = 1", language: "typescript", theme: "one-light", diff: false) == nil)
        let a = try await hl.highlight("let memo = 1", language: "typescript", theme: "one-light", appearance: .light)
        #expect(a != nil)
        #expect(hl.cached("let memo = 1", language: "typescript", theme: "one-light", diff: false) == .some(a))
        // Same code as a diff, or in another theme, is its own entry.
        #expect(hl.cached("let memo = 1", language: "typescript", theme: "one-light", diff: true) == nil)
        #expect(hl.cached("let memo = 1", language: "typescript", theme: "pierre-light", diff: false) == nil)
        // An unbundled language is cached as plain: .some(nil), not a miss.
        _ = try await hl.highlight("x", language: "cobol", theme: "one-light", appearance: .light)
        let plain = hl.cached("x", language: "cobol", theme: "one-light", diff: false)
        #expect(plain != nil && plain! == nil)
        #expect(hl.cache.count == 2)
    }

    @Test func aJobCancelledBeforeItsTurnIsSkippedAndNotCached() async throws {
        let hl = Highlighter(scriptURL: try HighlighterScript.url.get())
        let job = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await hl.highlight("let stale = 1", language: "typescript", theme: "pierre-light", appearance: .light)
        }
        await #expect(throws: CancellationError.self) { try await job.value }
        #expect(hl.cached("let stale = 1", language: "typescript", theme: "pierre-light", diff: false) == nil)
    }

    @Test func aCachedResultStillComesBackForACancelledTask() async throws {
        let hl = Highlighter(scriptURL: try HighlighterScript.url.get())
        let first = try await hl.highlight("let kept = 1", language: "typescript", theme: "pierre-light", appearance: .light)
        let job = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await hl.highlight("let kept = 1", language: "typescript", theme: "pierre-light", appearance: .light)
        }
        #expect(try await job.value == first)
    }

    @Test func concurrentJobsEachGetTheirOwnResult() async throws {
        let hl = Highlighter(scriptURL: try HighlighterScript.url.get())
        let results = try await withThrowingTaskGroup(of: (Int, String).self) { group in
            for n in 0..<12 {
                group.addTask {
                    let r = try await hl.highlight("let v\(n) = \(n)", language: "typescript", theme: "pierre-dark", appearance: .dark)
                    return (n, r?.lines.first?.text ?? "")
                }
            }
            return try await group.reduce(into: [Int: String]()) { $0[$1.0] = $1.1 }
        }
        #expect(results.count == 12)
        #expect(results.allSatisfy { n, text in text == "let v\(n) = \(n)" })
    }

    @Test func aMissingScriptLeavesCodePlainAndReportsWhy() async throws {
        let hl = Highlighter { throw HighlighterError.scriptMissing }
        #expect(try await hl.highlight("let a = 1", language: "typescript", theme: "pierre-light", appearance: .light) == nil)
        await #expect(throws: HighlighterError.scriptMissing) { try await hl.languages() }
    }

    @Test func aScriptThatThrowsOrDefinesNoAPIFailsToLoad() async throws {
        let broken = Highlighter { "throw new Error('boom')" }
        await #expect(throws: HighlighterError.script("Error: boom")) { try await broken.warmUp() }
        let empty = Highlighter { "var x = 1" }
        await #expect(throws: HighlighterError.script("HarnessHighlighter isn't defined")) { try await empty.warmUp() }
    }

    @Test func aJobThatRejectsResolvesPlain() async throws {
        // A stand-in bundle whose highlight rejects asynchronously, after a promise job.
        let script = "var HarnessHighlighter = { languages: [], themes: [], highlight(c, l, t, d, a, done) { Promise.resolve().then(() => { throw new Error('nope') }).catch((e) => done(null, String(e))) } }"
        let hl = Highlighter { script }
        #expect(try await hl.highlight("x", language: "typescript", theme: "pierre-light", appearance: .light) == nil)
    }

    @Test func promiseJobsDrainBeforeTheCallReturns() async throws {
        // Resolves two promise hops later; the result must still be there synchronously.
        let script = """
        var HarnessHighlighter = { languages: ["x"], themes: [], highlight(c, l, t, d, a, done) {
          Promise.resolve().then(() => 0).then(() => done(JSON.stringify({ lines: [{ spans: [{ text: c }] }], fg: "#000", added: "#0f0", deleted: "#f00" }), null));
        } }
        """
        let hl = Highlighter { script }
        let r = try await hl.highlight("hi", language: "x", theme: "t", appearance: .light)
        #expect(r?.lines == [HighlightedLine(spans: [HighlightSpan(text: "hi")])])
    }

    @Test func reportsColdStartAndFirstHighlightLatency() async throws {
        let hl = Highlighter(scriptURL: try HighlighterScript.url.get())
        let clock = ContinuousClock()
        let load = try await hl.warmUp()
        let start = clock.now
        let r = try await hl.highlight("struct A { let b = \"c\" }", language: "swift", theme: "github-dark-default", appearance: .dark)
        let first = clock.now - start
        let again = clock.now
        _ = try await hl.highlight("struct B { let c = 1 }", language: "swift", theme: "github-dark-default", appearance: .dark)
        let second = clock.now - again
        print("highlighter: script load \(load), first swift highlight \(first), next \(second)")
        #expect(r != nil)
    }
}

@Suite("Highlight helpers match highlight.ts")
struct HighlightHelperTests {
    struct GitInput: Decodable, Sendable {
        let colors: [String: String]?
        let appearance: ThemeAppearance
    }

    struct TintInput: Decodable, Sendable {
        let bg: String
        let added: String
        let deleted: String
        let appearance: ThemeAppearance
    }

    struct PlainInput: Decodable, Sendable {
        let code: String
        let diff: Bool
    }

    struct ReuseInput: Decodable, Sendable {
        let plain: [HighlightedLine]
        let prev: [HighlightedLine]?
    }

    @Test(arguments: Fixture.cases("highlight", "gitColorsCases", input: GitInput.self, output: GitColors.self))
    func gitColors(_ c: Fixture.Case<GitInput, GitColors>) {
        #expect(HighlightColors.gitColors(c.input.colors, c.input.appearance) == c.output)
    }

    @Test(arguments: Fixture.cases("highlight", "diffTintsCases", input: TintInput.self, output: DiffTints.self))
    func diffTints(_ c: Fixture.Case<TintInput, DiffTints>) throws {
        let i = c.input
        #expect(try HighlightColors.diffTints(i.bg, GitColors(added: i.added, deleted: i.deleted), i.appearance) == c.output)
    }

    @Test func diffTintsRejectsANonColor() {
        #expect(throws: CSSColorError.self) { try HighlightColors.diffTints("nope", GitColors(added: "#0f0", deleted: "#f00"), .light) }
    }

    @Test(arguments: Fixture.cases("highlight", "plainLinesCases", input: PlainInput.self, output: [HighlightedLine].self))
    func plainLines(_ c: Fixture.Case<PlainInput, [HighlightedLine]>) {
        #expect(PlainLines.lines(c.input.code, diff: c.input.diff) == c.output)
    }

    @Test(arguments: Fixture.cases("highlight", "reuseLinesCases", input: ReuseInput.self, output: [HighlightedLine].self))
    func reuseLines(_ c: Fixture.Case<ReuseInput, [HighlightedLine]>) {
        #expect(PlainLines.reuse(c.input.plain, c.input.prev) == c.output)
    }

    @Test func plainLinesOfADiffMatchTheHighlightedLinesKindsAndText() async throws {
        // What a block shows before its colors land must line up with what replaces it.
        let code = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n const a = 1\n-let b = 2\n+let b = 3"
        let hl = Highlighter(scriptURL: try HighlighterScript.url.get())
        let colored = try #require(try await hl.highlightDiff(code, language: "diff", theme: "pierre-light", appearance: .light))
        let plain = PlainLines.lines(code, diff: true)
        #expect(plain.map(\.kind) == colored.lines.map(\.kind))
        #expect(plain.map(\.text) == colored.lines.map(\.text))
        #expect(PlainLines.reuse(plain, colored.lines) == colored.lines)
    }
}

@Suite struct HighlightCacheTests {
    private func key(_ s: String) -> HighlightCache.Key { .init(code: s, language: "ts", theme: "t", diff: false) }
    private let value = Highlighted(lines: [], fg: "#000", added: "#0f0", deleted: "#f00")

    @Test func dropsTheLeastRecentlyUsedPastCapacity() {
        let cache = HighlightCache(capacity: 2)
        cache.set(key("a"), value)
        cache.set(key("b"), nil)
        _ = cache.get(key("a")) // a is now more recent than b
        cache.set(key("c"), value)
        #expect(cache.count == 2)
        #expect(cache.get(key("b")) == nil)
        #expect(cache.get(key("a")) == .some(value))
        #expect(cache.get(key("c")) == .some(value))
    }

    @Test func resettingAKeyRefreshesItInsteadOfAddingOne() {
        let cache = HighlightCache(capacity: 2)
        cache.set(key("a"), nil)
        cache.set(key("b"), nil)
        cache.set(key("a"), value)
        cache.set(key("c"), nil)
        #expect(cache.get(key("a")) == .some(value))
        #expect(cache.get(key("b")) == nil)
    }
}
