import Foundation
import Testing
@testable import HarnessKit

@Suite struct LinkRoutingTests {
    let ticket = FileLinkContext(ticketKey: "GREET-1")

    @Test func webAndMailLinksOpenOutside() {
        #expect(LinkRouting.target("https://example.com/a b", context: ticket) == .external("https://example.com/a b"))
        #expect(LinkRouting.target("mailto:mark@example.com", context: ticket) == .external("mailto:mark@example.com"))
        // Any scheme, any case, with +.- in it.
        #expect(LinkRouting.target("X-Man.v2+git:thing", context: ticket) == .external("X-Man.v2+git:thing"))
    }

    @Test func harnessLinksThatArentFilesStayDeepLinks() {
        #expect(LinkRouting.target("harness://ticket/GREET-2", context: ticket) == .external("harness://ticket/GREET-2"))
        #expect(LinkRouting.target("HARNESS://board", context: ticket) == .external("HARNESS://board"))
    }

    @Test func fileLinksResolveInTheMarkdownsTicket() {
        #expect(LinkRouting.target("harness://file/src/app.ts#L3-L5", context: ticket) == .file(FileRouteParams(path: "src/app.ts", ticket: "GREET-1", start: "3", end: "5")))
        #expect(LinkRouting.target("Harness://file/src/app.ts", context: ticket) == .file(FileRouteParams(path: "src/app.ts", ticket: "GREET-1")))
        #expect(LinkRouting.target("src/app.ts#L9", context: FileLinkContext(projectId: "p1")) == .file(FileRouteParams(path: "src/app.ts", project: "p1", start: "9")))
        #expect(LinkRouting.target("/Users/me/x.md", context: ticket) == .file(FileRouteParams(path: "/Users/me/x.md", ticket: "GREET-1")))
    }

    @Test func aLinksOwnRootWinsOverTheScope() {
        #expect(LinkRouting.target("harness://file/a.ts?ticket=OTHER-9", context: ticket) == .file(FileRouteParams(path: "a.ts", ticket: "OTHER-9")))
    }

    @Test func aFileLinkWithNoRootIsAnError() {
        #expect(LinkRouting.target("src/app.ts", context: FileLinkContext()) == .noRoot)
        // A triage session that dispatched nothing has no root either.
        let triage = FileViewer.triageLinkContext(dispatchedKey: nil, dispatchedProjectId: nil)
        #expect(LinkRouting.target("harness://file/src/app.ts", context: triage) == .noRoot)
        #expect(LinkRouting.target("src/app.ts", context: FileViewer.triageLinkContext(dispatchedKey: "GREET-4", dispatchedProjectId: nil)) == .file(FileRouteParams(path: "src/app.ts", ticket: "GREET-4")))
    }

    @Test func schemeDetectionBoundaries() {
        // A digit first isn't a scheme; neither is a colon after a slash.
        #expect(!LinkRouting.hasScheme("1http:x"))
        #expect(!LinkRouting.hasScheme("src/a:b"))
        #expect(!LinkRouting.hasScheme("noscheme"))
        #expect(LinkRouting.hasScheme("a:"))
        #expect(!LinkRouting.hasHarnessScheme("harness"))
        #expect(!LinkRouting.hasHarnessScheme("harnessx:"))
    }
}

@Suite struct MarkdownTableTests {
    @Test func columnsTakeTheWidestCellPlusARoundingPoint() {
        let w = MarkdownTable.columnWidths([[40.2, 10], [12, 99.0]], columns: 2)
        #expect(w == [42, 100])
    }

    @Test func columnsAreCappedSoLongCellsWrap() {
        #expect(MarkdownTable.columnWidths([[600, 239.5], [10, 1]], columns: 2) == [240, 240])
        #expect(MarkdownTable.columnWidths([[238.5]], columns: 1) == [240])
        #expect(MarkdownTable.columnWidths([[237.9]], columns: 1) == [239])
        #expect(MarkdownTable.columnWidths([[600]], columns: 1, cap: 100) == [100])
    }

    @Test func shortRowsAndUnmeasuredColumns() {
        #expect(MarkdownTable.columnWidths([[30], [20, 50]], columns: 3) == [31, 51, 0])
        #expect(MarkdownTable.columnWidths([[Double.nan, .infinity]], columns: 2) == [0, 0])
        #expect(MarkdownTable.columnWidths([], columns: 0) == [])
    }

    @Test func rowsTakeTheTallestCell() {
        #expect(MarkdownTable.rowHeights([[20, 44.2, 30], [18], []]) == [45, 18, 0])
    }

    @Test func tablesAndCodeScrollSideways() {
        #expect(MarkdownTable.scrollsSideways("| a | b |\n| - | - |\n| 1 | 2 |"))
        #expect(MarkdownTable.scrollsSideways("Look:\n\n```ts\nlet x = 1\n```"))
        #expect(!MarkdownTable.scrollsSideways("# Title\n\n- one | two\n- `code`"))
    }
}
