import Testing
@testable import HarnessKit

@Suite("Releases")
struct ReleasesTests {
    @Test func aReleaseBuildNumberIsTheTagsTwelveDigits() {
        #expect(Releases.tag(buildNumber: "202610031524") == "app-20261003.1524")
        // Development builds (CURRENT_PROJECT_VERSION "1") and anything else belong to no release.
        #expect(Releases.tag(buildNumber: "1") == nil)
        #expect(Releases.tag(buildNumber: "20261003152") == nil)
        #expect(Releases.tag(buildNumber: "2026100315240") == nil)
        #expect(Releases.tag(buildNumber: "2026100315a4") == nil)
        #expect(Releases.tag(buildNumber: "２０２６１００３１５２４") == nil) // full-width digits
        #expect(Releases.tag(buildNumber: nil) == nil)
    }

    @Test func onlyAppTagsHaveDigits() {
        #expect(Releases.digits(tag: "app-20261003.1524") == "202610031524")
        #expect(Releases.digits(tag: "v1.2.3") == nil)
        #expect(Releases.digits(tag: "app-20261003") == nil)
        #expect(Releases.digits(tag: "app-20261003.152") == nil)
        #expect(Releases.digits(tag: "app-2026100.31524") == nil)
        #expect(Releases.digits(tag: "app-20261003.1524.1") == nil)
        #expect(Releases.digits(tag: "app-2026x003.1524") == nil)
    }

    @Test func theOlderSideIsNamed() {
        #expect(Releases.mismatch(appBuild: "202610031524", serviceRelease: "app-20261003.1524") == nil)
        #expect(Releases.mismatch(appBuild: "202609271854", serviceRelease: "app-20261003.1524") == .appOlder(app: "app-20260927.1854", service: "app-20261003.1524"))
        #expect(Releases.mismatch(appBuild: "202610031524", serviceRelease: "app-20260927.1854") == .appNewer(app: "app-20261003.1524", service: "app-20260927.1854"))
        // The minute counts: same day, later release.
        #expect(Releases.mismatch(appBuild: "202610031524", serviceRelease: "app-20261003.1525") == .appOlder(app: "app-20261003.1524", service: "app-20261003.1525"))
    }

    @Test func eitherSideUnknownIsNoMismatch() {
        #expect(Releases.mismatch(appBuild: "1", serviceRelease: "app-20261003.1524") == nil)
        #expect(Releases.mismatch(appBuild: "202610031524", serviceRelease: nil) == nil)
        #expect(Releases.mismatch(appBuild: "202610031524", serviceRelease: "garbage") == nil)
    }

    @Test func theMessageSaysWhichSideToUpdate() {
        let older = ReleaseMismatch.appOlder(app: "app-20260927.1854", service: "app-20261003.1524")
        #expect(older.detail == "App app-20260927.1854, service app-20261003.1524. Update Harness from TestFlight.")
        let newer = ReleaseMismatch.appNewer(app: "app-20261003.1524", service: "app-20260927.1854")
        #expect(newer.detail == "App app-20261003.1524, service app-20260927.1854. Update Harness on the Mac.")
    }
}
