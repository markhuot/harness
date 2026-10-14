import Foundation
import Testing
@testable import HarnessKit

@Suite struct FileEditorBridgeTests {
    static let theme = FileEditorTheme(appearance: .dark, tokens: Themes.find(Themes.defaultDarkTheme)!.tokens)

    static func payload(_ c: FileEditorCommand) throws -> [String: JSONValue] {
        let prefix = "window.harnessEditor.receive("
        let suffix = "); true;"
        #expect(c.script.hasPrefix(prefix) && c.script.hasSuffix(suffix))
        let json = String(c.script.dropFirst(prefix.count).dropLast(suffix.count))
        guard case let .object(o) = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) else { throw CodecError.notObject }
        return o
    }

    enum CodecError: Error { case notObject }

    @Test func openCarriesTheRangeAndEveryToken() throws {
        let o = try Self.payload(.open(contents: "a\n\"b\"\u{2028}", language: "src/a.ts", theme: Self.theme, range: 3...9, readOnly: true, saved: nil))
        #expect(o["type"] == .string("open"))
        #expect(o["contents"] == .string("a\n\"b\"\u{2028}"))
        #expect(o["language"] == .string("src/a.ts"))
        #expect(o["readOnly"] == .bool(true))
        #expect(o["range"] == .object(["start": .number(3), "end": .number(9)]))
        guard case let .object(theme)? = o["theme"], case let .object(tokens)? = theme["tokens"] else { Issue.record("no theme"); return }
        #expect(theme["appearance"] == .string("dark"))
        #expect(theme["syntaxTheme"] == .string("pierre-dark"))
        #expect(tokens.count == ThemeToken.allCases.count)
        #expect(tokens["bg"] == .string(Self.theme.tokens.bg))
    }

    @Test func theCodeIsColoredWithTheAppThemesShikiThemeElsePierres() throws {
        let tokens = Themes.find(Themes.defaultDarkTheme)!.tokens
        let named = FileEditorTheme(appearance: .dark, tokens: tokens, syntaxTheme: "dracula")
        #expect(named.syntaxTheme == "dracula")
        #expect(FileEditorTheme(appearance: .light, tokens: tokens, syntaxTheme: nil).syntaxTheme == "pierre-light")
        // Not a plausible Shiki name: Pierre's default for the appearance.
        #expect(FileEditorTheme(appearance: .dark, tokens: tokens, syntaxTheme: "Not A Theme!").syntaxTheme == "pierre-dark")
        let o = try Self.payload(.theme(named))
        guard case let .object(theme)? = o["theme"] else { Issue.record("no theme"); return }
        #expect(theme["syntaxTheme"] == .string("dracula"))
        // A theme that changes only its Shiki theme is a different theme, so the page redraws.
        #expect(named != FileEditorTheme(appearance: .dark, tokens: tokens))
    }

    @Test func openWithoutARangeOmitsIt() throws {
        let o = try Self.payload(.open(contents: "", language: "a", theme: Self.theme, range: nil, readOnly: false, saved: nil))
        #expect(o["range"] == nil)
    }

    @Test func aReopenedEditorCarriesWhatIsOnDisk() throws {
        let dirty = try Self.payload(.open(contents: "edited", language: "a", theme: Self.theme, range: nil, readOnly: false, saved: "disk"))
        #expect(dirty["saved"] == .string("disk"))
        let clean = try Self.payload(.open(contents: "same", language: "a", theme: Self.theme, range: nil, readOnly: false, saved: "same"))
        #expect(clean["saved"] == nil)
        #expect(try Self.payload(.scrollToCursor)["type"] == .string("scrollToCursor"))
    }

    @Test func lineSeparatorsStayEscapedInTheScript() {
        // U+2028 raw in a script is a line break to older JS parsers.
        let s = FileEditorCommand.setContents("x\u{2028}y").script
        #expect(!s.contains("\u{2028}"))
        #expect(s.contains("\\u2028"))
    }

    @Test func markSavedWithoutContentsMeansTheDocumentAsItIs() throws {
        #expect(try Self.payload(.markSaved(nil))["contents"] == nil)
        #expect(try Self.payload(.markSaved("x"))["contents"] == .string("x"))
    }

    @Test func commandsNameTheirTypes() throws {
        #expect(try Self.payload(.reveal(2...2))["range"] == .object(["start": .number(2), "end": .number(2)]))
        #expect(try Self.payload(.getContents(id: "k"))["id"] == .string("k"))
        #expect(try Self.payload(.focus)["type"] == .string("focus"))
        #expect(try Self.payload(.theme(Self.theme))["type"] == .string("theme"))
        let d = try Self.payload(.diff(original: "a", modified: "b", language: "x.ts", theme: Self.theme))
        #expect(d["original"] == .string("a") && d["modified"] == .string("b"))
    }

    @Test func decodesEveryEvent() {
        #expect(FileEditorEvent.decode(json: #"{"type":"ready"}"#) == .ready)
        #expect(FileEditorEvent.decode(json: #"{"type":"blur"}"#) == .blur)
        #expect(FileEditorEvent.decode(json: #"{"type":"change","contents":"a\nb","dirty":true}"#) == .change(contents: "a\nb", dirty: true))
        #expect(FileEditorEvent.decode(json: #"{"type":"dirty","dirty":false}"#) == .dirty(false))
        #expect(FileEditorEvent.decode(json: #"{"type":"save","contents":"é"}"#) == .save(contents: "é"))
        #expect(FileEditorEvent.decode(json: #"{"type":"error","message":"boom"}"#) == .error("boom"))
        #expect(FileEditorEvent.decode(json: #"{"type":"contents","id":"7","contents":"z"}"#) == .contents(id: "7", contents: "z"))
        #expect(FileEditorEvent.decode(json: #"{"type":"contents","contents":"z"}"#) == .contents(id: nil, contents: "z"))
    }

    @Test func dropsWhatItCantRead() {
        #expect(FileEditorEvent.decode(json: "not json") == nil)
        #expect(FileEditorEvent.decode(json: #"{"type":"change","contents":"a"}"#) == nil)
        #expect(FileEditorEvent.decode(json: #"{"type":"save"}"#) == nil)
        #expect(FileEditorEvent.decode(json: #"{"type":"mystery"}"#) == nil)
        #expect(FileEditorEvent.decode(body: 5) == nil)
        #expect(FileEditorEvent.decode(body: #"{"type":"ready"}"#) == .ready)
    }
}

@Suite struct FileEditRulesTests {
    static func view(contents: String? = "a", binary: Bool = false, tooLarge: Bool = false, truncated: Bool = false) -> FileView {
        FileView(path: "a", root: "/w", size: 1, contents: contents, binary: binary, truncated: truncated, tooLarge: tooLarge,
                 git: FileGitState(repo: true, tracked: true, dirty: false, untracked: false, ignored: false))
    }

    @Test func onlyAWholeTextFileIsEditable() {
        #expect(FileEditRules.canEdit(Self.view()))
        #expect(FileEditRules.canEdit(Self.view(contents: "")))
        #expect(!FileEditRules.canEdit(Self.view(contents: nil)))
        #expect(!FileEditRules.canEdit(Self.view(binary: true)))
        #expect(!FileEditRules.canEdit(Self.view(tooLarge: true)))
        #expect(!FileEditRules.canEdit(Self.view(truncated: true)))
    }

    @Test func leavingADirtyFileSavesOrAsksButNeverDrops() {
        #expect(FileEditRules.leave(dirty: false, saveOnBlur: true) == .none)
        #expect(FileEditRules.leave(dirty: false, saveOnBlur: false) == .none)
        #expect(FileEditRules.leave(dirty: true, saveOnBlur: true) == .save)
        #expect(FileEditRules.leave(dirty: true, saveOnBlur: false) == .prompt)
    }

    @Test func blurSavesOnlyDirtyEditsWithTheSettingOn() {
        #expect(FileEditRules.saveOnBlur(dirty: true, saveOnBlur: true))
        #expect(!FileEditRules.saveOnBlur(dirty: true, saveOnBlur: false))
        #expect(!FileEditRules.saveOnBlur(dirty: false, saveOnBlur: true))
    }

    @Test func foregroundReloadsOnlyACleanEditor() {
        #expect(FileEditRules.reloadOnForeground(dirty: false))
        #expect(!FileEditRules.reloadOnForeground(dirty: true))
    }

    @Test func statusPrefersSaving() {
        #expect(FileEditRules.statusLabel(saving: true, error: "x") == "Saving…")
        #expect(FileEditRules.statusLabel(saving: false, error: "Disk full") == "Save failed: Disk full")
        #expect(FileEditRules.statusLabel(saving: false, error: nil) == nil)
    }
}
