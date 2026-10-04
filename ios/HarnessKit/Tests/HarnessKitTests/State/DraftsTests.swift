import Foundation
import Testing
@testable import HarnessKit

struct DRBlankInput: Decodable, Sendable {
    let project: Project
    let settings: DraftSettings?
    let key: String
    let now: Double
}

struct DRPatchInput: Decodable, Sendable {
    let ticket: Ticket
    let patch: UpdateTicketBody
}

struct DRTicketProjectInput: Decodable, Sendable {
    let ticket: Ticket
    let project: Project?
}

struct DREmptyInput: Decodable, Sendable {
    let ticket: Ticket
    let project: Project?
    let settings: DraftSettings?
}

struct DRCreateInput: Decodable, Sendable {
    let ticket: Ticket
    let project: Project
}

struct DRDiffInput: Decodable, Sendable {
    let prev: Ticket
    let next: Ticket
}

struct DRSkipsInput: Decodable, Sendable {
    let ticket: Ticket
    let from: Project?
    let to: Project?
}

struct DRPickInput: Decodable, Sendable {
    let name: String?
    let checkout: BranchInfo?
}

struct DRBranchPatchInput: Decodable, Sendable {
    let pick: Drafts.DraftBranchPick
    let project: Project
}

struct DRValueInput: Decodable, Sendable {
    let ticket: Ticket
    let project: Project
    let checkout: BranchInfo?
}

struct DRLabelInput: Decodable, Sendable {
    let key: String
    let project: Project
    let checkout: BranchInfo?
}

struct DRChoiceInput: Decodable, Sendable {
    let ticket: Ticket
    let project: Project
    let known: [BranchInfo]
    let checkout: BranchInfo?
    let settings: DraftSettings?
}

struct DRToneInput: Decodable, Sendable {
    let tone: BranchHint.Tone
}

struct DRSummaryInput: Decodable, Sendable {
    let ticket: Ticket
    let project: Project
    let settings: DraftSettings?
    /// labels.model as a lookup by "<driver>:<model>"
    let models: [String: String]?
    let drivers: [String: String]?
    let checkoutName: String?
}

@Suite("state/drafts.ts parity")
struct DraftsTests {
    @Test(arguments: Fixture.cases("stateDrafts", "blankDraftTicketCases", input: DRBlankInput.self, output: JSONValue.self))
    func blankDraftTicket(_ c: Fixture.Case<DRBlankInput, JSONValue>) throws {
        let t = Drafts.blankDraftTicket(project: c.input.project, settings: c.input.settings, key: c.input.key, now: c.input.now)
        try expectJSONMatchesTS(t, c.output)
    }

    @Test func blankDraftTicketDefaultsToNow() {
        let project = Project(id: "p1", key: "WEB", name: "web", path: "/w", nextSeq: 4, useWorktrees: true, createdAt: 0, updatedAt: 0)
        let before = Date().timeIntervalSince1970 * 1000
        let t = Drafts.blankDraftTicket(project: project, settings: nil, key: "WEB-4")
        #expect(t.createdAt >= before && t.createdAt <= Date().timeIntervalSince1970 * 1000)
    }

    /// promptAttachments.test.ts: "an annotation change is a change: the draft patch sends the list
    /// with it".
    @Test func anAnnotationChangeSendsTheListWithIt() {
        let project = Project(id: "p1", key: "WEB", name: "web", path: "/w", nextSeq: 1, useWorktrees: true, createdAt: 0, updatedAt: 0)
        let shot = PromptAttachment(path: "/d/shot.png", name: "shot.png", source: .file)
        let note = AttachmentAnnotation(width: 10, height: 10, marks: [AnnotationMark(n: 1, x: 1, y: 1, message: "here")])
        var a = Drafts.blankDraftTicket(project: project, settings: nil, key: "WEB-1", now: 0)
        a.promptAttachments = [shot]
        var b = a
        b.promptAttachments = [PromptAttachment(path: shot.path, name: shot.name, source: .file, annotation: note)]
        let withNote = [PromptAttachmentInput(path: shot.path, name: shot.name, annotation: note)]
        #expect(Drafts.draftPatch(a, b) == UpdateTicketBody(promptAttachments: withNote))
        // And back: taking the notes off is a change too.
        #expect(Drafts.draftPatch(b, a) == UpdateTicketBody(promptAttachments: [PromptAttachmentInput(path: shot.path, name: shot.name)]))
        #expect(Drafts.draftPatch(b, b) == nil)
        #expect(Drafts.draftCreateBody(b, project: project).promptAttachments == withNote)
        #expect(Drafts.applyTicketPatch(a, UpdateTicketBody(promptAttachments: [PromptAttachmentInput(path: shot.path, annotation: note)])).promptAttachments == b.promptAttachments)
        // Removing every attachment sends an empty list.
        var none = a
        none.promptAttachments = []
        #expect(Drafts.draftPatch(a, none) == UpdateTicketBody(promptAttachments: []))
    }

    @Test(arguments: Fixture.cases("stateDrafts", "draftReviewSkipsPatchCases", input: DRSkipsInput.self, output: JSONValue.self))
    func draftReviewSkipsPatch(_ c: Fixture.Case<DRSkipsInput, JSONValue>) throws {
        try expectJSONMatchesTS(Drafts.draftReviewSkipsPatch(c.input.ticket, from: c.input.from, to: c.input.to), c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "applyTicketPatchCases", input: DRPatchInput.self, output: JSONValue.self))
    func applyTicketPatch(_ c: Fixture.Case<DRPatchInput, JSONValue>) throws {
        try expectJSONMatchesTS(Drafts.applyTicketPatch(c.input.ticket, c.input.patch), c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "draftUsesWorktreeCases", input: DRTicketProjectInput.self, output: Bool.self))
    func draftUsesWorktree(_ c: Fixture.Case<DRTicketProjectInput, Bool>) {
        #expect(Drafts.draftUsesWorktree(c.input.ticket, project: c.input.project) == c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "draftIsEmptyCases", input: DREmptyInput.self, output: Bool.self))
    func draftIsEmpty(_ c: Fixture.Case<DREmptyInput, Bool>) {
        #expect(Drafts.draftIsEmpty(c.input.ticket, project: c.input.project, settings: c.input.settings) == c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "draftCreateBodyCases", input: DRCreateInput.self, output: JSONValue.self))
    func draftCreateBody(_ c: Fixture.Case<DRCreateInput, JSONValue>) throws {
        try expectJSONMatchesTS(Drafts.draftCreateBody(c.input.ticket, project: c.input.project), c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "draftPatchCases", input: DRDiffInput.self, output: JSONValue.self))
    func draftPatch(_ c: Fixture.Case<DRDiffInput, JSONValue>) throws {
        let patch = Drafts.draftPatch(c.input.prev, c.input.next)
        if c.output == .null {
            #expect(patch == nil)
        } else {
            let patch = try #require(patch)
            try expectJSONMatchesTS(patch, c.output)
        }
    }

    @Test(arguments: Fixture.cases("stateDrafts", "ticketSettingsRowsCases", input: DRTicketProjectInput.self, output: Drafts.TicketSettingsRows.self))
    func ticketSettingsRows(_ c: Fixture.Case<DRTicketProjectInput, Drafts.TicketSettingsRows>) {
        #expect(Drafts.ticketSettingsRows(c.input.ticket, project: c.input.project) == c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "draftBranchPickCases", input: DRPickInput.self, output: Drafts.DraftBranchPick.self))
    func draftBranchPick(_ c: Fixture.Case<DRPickInput, Drafts.DraftBranchPick>) {
        #expect(Drafts.draftBranchPick(c.input.name, checkout: c.input.checkout) == c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "draftBranchPatchCases", input: DRBranchPatchInput.self, output: JSONValue.self))
    func draftBranchPatch(_ c: Fixture.Case<DRBranchPatchInput, JSONValue>) throws {
        try expectJSONMatchesTS(Drafts.draftBranchPatch(c.input.pick, project: c.input.project), c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "draftBranchValueCases", input: DRValueInput.self, output: String?.self))
    func draftBranchValue(_ c: Fixture.Case<DRValueInput, String?>) {
        #expect(Drafts.draftBranchValue(c.input.ticket, project: c.input.project, checkout: c.input.checkout) == c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "draftDefaultBranchLabelCases", input: DRLabelInput.self, output: String.self))
    func draftDefaultBranchLabel(_ c: Fixture.Case<DRLabelInput, String>) {
        #expect(Drafts.draftDefaultBranchLabel(key: c.input.key, project: c.input.project, checkout: c.input.checkout) == c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "ticketBranchChoiceCases", input: DRChoiceInput.self, output: BranchChoice.self))
    func ticketBranchChoice(_ c: Fixture.Case<DRChoiceInput, BranchChoice>) {
        #expect(Drafts.ticketBranchChoice(c.input.ticket, project: c.input.project, known: c.input.known, checkout: c.input.checkout) == c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "ticketBranchHintCases", input: DRChoiceInput.self, output: BranchHint.self))
    func ticketBranchHint(_ c: Fixture.Case<DRChoiceInput, BranchHint>) {
        let hint = Drafts.ticketBranchHint(c.input.ticket, project: c.input.project, settings: c.input.settings, known: c.input.known, checkout: c.input.checkout)
        #expect(hint == c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "optionsNeedAttentionCases", input: DRToneInput.self, output: Bool.self))
    func optionsNeedAttention(_ c: Fixture.Case<DRToneInput, Bool>) {
        #expect(Drafts.optionsNeedAttention(c.input.tone) == c.output)
        #expect(Drafts.optionsNeedAttention(BranchHint(text: "", tone: c.input.tone)) == c.output)
    }

    @Test(arguments: Fixture.cases("stateDrafts", "newSessionOptionsSummaryCases", input: DRSummaryInput.self, output: [String].self))
    func newSessionOptionsSummary(_ c: Fixture.Case<DRSummaryInput, [String]>) {
        let models = c.input.models
        let drivers = c.input.drivers
        let labels = Drafts.OptionsSummaryLabels(
            model: models.map { m in { d, model in m["\(d):\(model ?? "null")"] } },
            driver: drivers.map { m in { d in m[d] ?? d } },
            checkoutName: c.input.checkoutName
        )
        #expect(Drafts.newSessionOptionsSummary(c.input.ticket, project: c.input.project, settings: c.input.settings, labels: labels) == c.output)
    }
}
