import Foundation
import Testing
import HarnessKit

/// Label names, search qualifiers and the sidebar's Labels section, against shared/src/labels.fixtures.json,
/// which the TypeScript tests read too, so the two can't drift.
@Suite struct LabelsTests {
    private static func fixtures() throws -> [String: [Any]] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/src/labels.fixtures.json")
        return try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: [Any]])
    }

    @Test func parseMatchesTheSharedFixtures() throws {
        let cases = try #require(Self.fixtures()["parse"] as? [[String: Any]])
        #expect(cases.count > 10)
        for c in cases {
            let q = c["q"] as! String
            let p = SearchQuery.parse(q)
            #expect(p.labels == c["labels"] as! [String], "\(q)")
            #expect(p.projects == c["projects"] as! [String], "\(q)")
            #expect(p.text == c["text"] as! String, "\(q)")
            #expect(p.qualifiers == c["qualifiers"] as! Int, "\(q)")
            if let comp = c["completion"] as? [String: Any] {
                #expect(p.completion?.field.rawValue == comp["field"] as? String, "\(q)")
                #expect(p.completion?.partial == comp["partial"] as? String, "\(q)")
                #expect(p.completion?.start == comp["start"] as? Int, "\(q)")
            } else {
                #expect(p.completion == nil, "\(q)")
            }
        }
    }

    @Test func quoteAndCompleteMatchTheSharedFixtures() throws {
        for pair in try #require(Self.fixtures()["quote"] as? [[String]]) {
            #expect(SearchQuery.quote(pair[0]) == pair[1])
        }
        for c in try #require(Self.fixtures()["complete"] as? [[String]]) {
            #expect(SearchQuery.complete(c[0], field: ParsedSearch.Field(rawValue: c[1])!, value: c[2]) == c[3], "\(c[0])")
        }
    }

    @Test func namesAndKeysMatchTheSharedFixtures() throws {
        for pair in try #require(Self.fixtures()["names"]) as! [[Any]] {
            #expect(LabelName.normalize(pair[0] as! String) == pair[1] as? String, "\(pair[0])")
        }
        for pair in try #require(Self.fixtures()["keys"]) as! [[String]] {
            #expect(LabelName.key(pair[0]) == pair[1], "\(pair[0])")
        }
    }

    @Test func overlongNamesAreRefusedWithAMessage() {
        let long = String(repeating: "a", count: 41)
        #expect(LabelName.normalize(long) == nil)
        #expect(LabelName.normalize(String(repeating: "a", count: 40)) != nil)
        #expect(LabelName.rejection(long)?.contains("40") == true)
        #expect(LabelName.rejection("say \"hi\"") != nil)
        #expect(LabelName.rejection("  ") != nil)
        #expect(LabelName.rejection("Bugfix") == nil)
    }

    @Test func addingAndRemovingCompareByKey() {
        #expect(LabelName.adding("bugfix", to: ["Bugfix"]) == nil)
        #expect(LabelName.adding(" Docs ", to: ["Bugfix"]) == ["Bugfix", "Docs"])
        #expect(LabelName.adding("\"", to: ["Bugfix"]) == nil)
        #expect(LabelName.removing("BUGFIX", from: ["Bugfix", "Docs"]) == ["Docs"])
        #expect(LabelName.normalizeAll(["A", "a", " B  b "]) == ["A", "B b"])
    }

    private func label(_ name: String, count: Int) -> LabelInfo {
        LabelInfo(name: name, color: "red", createdAt: 0, lastUsedAt: 0, count: count)
    }

    @Test func sectionHidesZeroCountsAndPagesByTen() {
        let labels = (0..<25).map { label("L\($0)", count: $0 % 5 == 0 ? 0 : 1) }
        let visible = labels.filter { $0.count > 0 }.count  // 20
        let first = LabelList.section(labels)
        #expect(first.rows.count == 10)
        #expect(first.rows.first?.name == "L1")
        #expect(first.hidden == visible - 10)
        let second = LabelList.section(labels, pages: 1)
        #expect(second.rows.count == 20 && second.hidden == 0)
        #expect(LabelList.section(labels, pages: 5).rows.count == 20)
        #expect(LabelList.section([label("Z", count: 0)]).rows.isEmpty)
    }

    @Test func suggestionsMatchWordPrefixesAndSkipTakenLabels() {
        let labels = [label("Release 1.2.3", count: 1), label("Bugfix", count: 1), label("Café", count: 1)]
        #expect(LabelList.suggestions("1.2", labels: labels, excluding: []).map(\.name) == ["Release 1.2.3"])
        #expect(LabelList.suggestions("cafe", labels: labels, excluding: []).map(\.name) == ["Café"])
        #expect(LabelList.suggestions("", labels: labels, excluding: ["bugfix"]).count == 2)
    }

    @Test func defaultColorIsStableAndAPreset() {
        let c = LabelList.defaultColor("Bugfix")
        #expect(c == LabelList.defaultColor("BUGFIX"))
        #expect(ProjectColors.isProjectColorId(c))
    }
}
