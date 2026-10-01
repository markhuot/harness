import Foundation
import Testing
@testable import HarnessKit

struct ThumbnailBoxInput: Decodable, Sendable {
    let a: AttachmentDimensions
    let height: Double
}

struct StepAttachmentInput: Decodable, Sendable {
    let index: Int
    let delta: Int
    let count: Int
}

struct ThumbSizeCustomInput: Decodable, Sendable {
    let a: AttachmentDimensions
    let t: Attachments.ThumbMetrics
}

struct FitSizeInput: Decodable, Sendable {
    let a: AttachmentDimensions
    let box: AttachmentSize
}

struct ClampPageInput: Decodable, Sendable {
    let index: Double
    let count: Int
}

struct PageAtInput: Decodable, Sendable {
    let offsetX: Double
    let pageWidth: Double
    let count: Int
}

struct ShouldDismissInput: Decodable, Sendable {
    let dy: Double
    let vy: Double
}

struct PullOfInput: Decodable, Sendable {
    let offsetY: Double
    let zoomScale: Double?
}

struct DismissOnReleaseInput: Decodable, Sendable {
    let offsetY: Double
    let velocityY: Double
    let zoomScale: Double?
}

struct AttachmentConstants: Decodable {
    let THUMB: Attachments.ThumbMetrics
    let DISMISS: Attachments.DismissThresholds
}

@Suite("attachments.ts parity")
struct AttachmentsTests {
    @Test("THUMB and DISMISS match the TS")
    func constants() throws {
        let c = try Fixture.value("attachments", "constants", as: AttachmentConstants.self)
        #expect(Attachments.thumb == c.THUMB)
        #expect(Attachments.dismiss == c.DISMISS)
    }

    @Test(arguments: Fixture.cases("attachments", "thumbnailBoxCases", input: ThumbnailBoxInput.self, output: AttachmentSize.self))
    func thumbnailBox(_ c: Fixture.Case<ThumbnailBoxInput, AttachmentSize>) {
        #expect(Attachments.thumbnailBox(c.input.a, height: c.input.height) == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "stepAttachmentCases", input: StepAttachmentInput.self, output: Int.self))
    func stepAttachment(_ c: Fixture.Case<StepAttachmentInput, Int>) {
        #expect(Attachments.stepAttachment(index: c.input.index, delta: c.input.delta, count: c.input.count) == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "attachmentsLabelCases", input: [AttachmentKind].self, output: String.self))
    func attachmentsLabel(_ c: Fixture.Case<[AttachmentKind], String>) {
        #expect(Attachments.attachmentsLabel(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "thumbSizeCases", input: AttachmentDimensions.self, output: AttachmentSize.self))
    func thumbSize(_ c: Fixture.Case<AttachmentDimensions, AttachmentSize>) {
        #expect(Attachments.thumbSize(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "thumbSizeCustomCases", input: ThumbSizeCustomInput.self, output: AttachmentSize.self))
    func thumbSizeCustom(_ c: Fixture.Case<ThumbSizeCustomInput, AttachmentSize>) {
        #expect(Attachments.thumbSize(c.input.a, metrics: c.input.t) == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "fitSizeCases", input: FitSizeInput.self, output: AttachmentSize.self))
    func fitSize(_ c: Fixture.Case<FitSizeInput, AttachmentSize>) {
        #expect(Attachments.fitSize(c.input.a, in: c.input.box) == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "clampPageCases", input: ClampPageInput.self, output: Int.self))
    func clampPage(_ c: Fixture.Case<ClampPageInput, Int>) {
        #expect(Attachments.clampPage(c.input.index, count: c.input.count) == c.output)
    }

    @Test("clampPage: non-finite indexes JSON can't carry")
    func clampPageNonFinite() {
        #expect(Attachments.clampPage(.nan, count: 3) == 0)
        #expect(Attachments.clampPage(.infinity, count: 3) == 0)
        #expect(Attachments.clampPage(-.infinity, count: 3) == 0)
    }

    @Test(arguments: Fixture.cases("attachments", "pageAtCases", input: PageAtInput.self, output: Int.self))
    func pageAt(_ c: Fixture.Case<PageAtInput, Int>) {
        #expect(Attachments.pageAt(offsetX: c.input.offsetX, pageWidth: c.input.pageWidth, count: c.input.count) == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "shouldDismissCases", input: ShouldDismissInput.self, output: Bool.self))
    func shouldDismiss(_ c: Fixture.Case<ShouldDismissInput, Bool>) {
        #expect(Attachments.shouldDismiss(dy: c.input.dy, vy: c.input.vy) == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "pullOfCases", input: PullOfInput.self, output: Double.self))
    func pullOf(_ c: Fixture.Case<PullOfInput, Double>) {
        let got = c.input.zoomScale.map { Attachments.pullOf(offsetY: c.input.offsetY, zoomScale: $0) } ?? Attachments.pullOf(offsetY: c.input.offsetY)
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "dismissOnReleaseCases", input: DismissOnReleaseInput.self, output: Bool.self))
    func dismissOnRelease(_ c: Fixture.Case<DismissOnReleaseInput, Bool>) {
        let i = c.input
        let got = i.zoomScale.map { Attachments.dismissOnRelease(offsetY: i.offsetY, velocityY: i.velocityY, zoomScale: $0) }
            ?? Attachments.dismissOnRelease(offsetY: i.offsetY, velocityY: i.velocityY)
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("attachments", "formatSizeCases", input: Double.self, output: String.self))
    func formatSize(_ c: Fixture.Case<Double, String>) {
        #expect(Attachments.formatSize(c.input) == c.output)
    }

    @Test("formatSize is empty for sizes JSON can't carry")
    func formatSizeNonFinite() {
        #expect(Attachments.formatSize(.nan) == "")
        #expect(Attachments.formatSize(.infinity) == "")
    }

    @Test("SummaryAttachment overloads read its kind and pixel size")
    func summaryAttachmentOverloads() {
        let video = SummaryAttachment(id: "1", kind: .video, mimeType: "video/mp4", name: "a.mp4", size: 1)
        let wide = SummaryAttachment(id: "2", kind: .image, mimeType: "image/png", name: "a.png", size: 1, width: 2000, height: 1000)
        #expect(Attachments.thumbSize(video).width == 213)
        #expect(Attachments.thumbSize(wide).width == 240)
        #expect(Attachments.thumbnailBox(wide, height: 100).width == 200)
        #expect(Attachments.fitSize(wide, in: AttachmentSize(width: 390, height: 700)) == AttachmentSize(width: 390, height: 195))
        #expect(Attachments.attachmentsLabel([video, wide, wide]) == "2 images, 1 video")
    }
}
