import Foundation
import Testing
import HarnessKit

/// The file viewer's wrap key and the "…" menu rules, against the fixtures shared/src/viewOptions.fixtures.json
/// that the Mac's TypeScript tests read too, so the two can't drift.
@Suite struct ViewOptionsTests {
    private static func fixtures() -> [String: [[Any]]] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/src/viewOptions.fixtures.json")
        return (try? JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: [[Any]]]) ?? [:]
    }

    @Test func wrapKeysMatchTheSharedFixtures() throws {
        let keys = try #require(Self.fixtures()["keys"])
        #expect(keys.count > 5)
        for pair in keys {
            let (path, key) = (pair[0] as! String, pair[1] as! String)
            #expect(ViewOptions.wrapKey(path) == key, "\(path)")
        }
    }

    @Test func renderedViewsMatchTheSharedFixtures() throws {
        let rendered = try #require(Self.fixtures()["rendered"])
        #expect(rendered.count > 3)
        for pair in rendered {
            let (path, yes) = (pair[0] as! String, pair[1] as! Bool)
            #expect(ViewOptions.hasRenderedView(path) == yes, "\(path)")
        }
    }

    @Test func relativeLinksResolveFromTheFilesDirectory() {
        #expect(ViewOptions.resolveFileRelative("docs/a.md", "./b.md#L3") == "docs/./b.md#L3")
        #expect(FileLinks.parseFileLink(ViewOptions.resolveFileRelative("docs/a.md", "./b.md#L3"))?.path == "docs/b.md")
        #expect(FileLinks.parseFileLink(ViewOptions.resolveFileRelative("docs/a.md", "../src/x.ts"))?.path == "src/x.ts")
        #expect(ViewOptions.resolveFileRelative("a.md", "b.md") == "b.md")
        #expect(ViewOptions.resolveFileRelative("docs/a.md", "/etc/hosts") == "/etc/hosts")
        #expect(ViewOptions.resolveFileRelative("docs/a.md", "https://x.dev/a") == "https://x.dev/a")
        #expect(FileLinks.parseFileLink(ViewOptions.resolveFileRelative("docs/a.md", "#top")) == nil)
    }

    @Test func aTappedRelativeLinkOpensBesideTheRenderedFile() {
        let context = FileLinkContext(ticketKey: "HARNESS-5", file: "docs/a.md")
        #expect(LinkRouting.target("./b.md", context: context) == .file(FileRouteParams(path: "docs/b.md", ticket: "HARNESS-5")))
        #expect(LinkRouting.target("https://x.dev", context: context) == .external("https://x.dev"))
        // With no file in the context, the link is relative to the root as before.
        #expect(LinkRouting.target("./b.md", context: FileLinkContext(ticketKey: "HARNESS-5")) == .file(FileRouteParams(path: "b.md", ticket: "HARNESS-5")))
    }

    @Test func menuRules() {
        func file(_ path: String, rendered: Bool = false) -> ViewMenu { ViewMenu(spec: false, path: path, rendered: rendered) }
        #expect(file("a.md").view)
        #expect(!file("a.ts").view)
        #expect(file("a.md").wrapEnabled)
        #expect(!file("a.md", rendered: true).wrapEnabled)
        #expect(file("a.ts", rendered: true).wrapEnabled)
        #expect(!file("a.md").showChanges)

        func spec(rendered: Bool = false, changes: Bool = false, canChange: Bool = true) -> ViewMenu {
            ViewMenu(spec: true, rendered: rendered, showChanges: changes, canShowChanges: canChange)
        }
        #expect(spec().showChanges)
        #expect(!spec(canChange: false).showChanges)
        let comparing = spec(changes: true)
        #expect(comparing.rendered && !comparing.sourceEnabled && !comparing.wrapEnabled)
        let first = spec(changes: true, canChange: false)
        #expect(!first.rendered && first.sourceEnabled)
        #expect(spec().wrapEnabled)
    }

    @MainActor @Test func wrapSettingsKeepOnlyWrappedTypesAndSurviveARestart() {
        let defaults = MemoryChangesDefaults()
        let settings = WrapSettings(defaults)
        settings.set(".html", true)
        settings.set(".ts", true)
        settings.set(".ts", false)
        #expect(ViewOptions.parseWrapPrefs(defaults.string(forKey: WrapSettings.key)) == [".html": true])
        let reopened = WrapSettings(defaults)
        #expect(reopened.isWrapped(".html"))
        #expect(!reopened.isWrapped(".ts"))
    }

    @Test(arguments: [nil, "", "nope", "[1]", "null", "\"x\""] as [String?])
    func unreadableWrapPrefsAreNoSettings(raw: String?) {
        #expect(ViewOptions.parseWrapPrefs(raw).isEmpty)
    }

    @Test func nonBooleanWrapPrefsAreDropped() {
        #expect(ViewOptions.parseWrapPrefs(#"{".a":true,".b":"yes",".c":1}"#) == [".a": true])
    }

    @Test func theEditorHearsWrapOnOpenAndAsACommand() throws {
        let theme = try #require(Themes.all.first)
        let editorTheme = FileEditorTheme(appearance: theme.appearance, tokens: theme.tokens)
        let open = FileEditorCommand.open(contents: "x", language: "a.md", theme: editorTheme, range: nil, readOnly: false, wrap: true, saved: nil)
        #expect(open.script.contains(#""wrap":true"#))
        let off = FileEditorCommand.open(contents: "x", language: "a.md", theme: editorTheme, range: nil, readOnly: false, wrap: false, saved: nil)
        #expect(off.script.contains(#""wrap":false"#))
        #expect(FileEditorCommand.wrap(true).script.contains(#""type":"wrap""#))
    }

    @Test func onlyViewMovingCommandsWaitForTheEditorToShow() {
        #expect(FileEditorCommand.reveal(1...2).needsVisibleEditor)
        #expect(FileEditorCommand.focus.needsVisibleEditor)
        #expect(FileEditorCommand.scrollToCursor.needsVisibleEditor)
        #expect(!FileEditorCommand.wrap(true).needsVisibleEditor)
        #expect(!FileEditorCommand.setContents("x").needsVisibleEditor)
        #expect(!FileEditorCommand.markSaved(nil).needsVisibleEditor)
    }
}
