import Testing
import HarnessKit

@Suite struct BoardChromeTests {
    @Test func aLandscapePhoneShowsColumnsSideBySideLikeTheIPad() {
        #expect(BoardScreenRules.layout(regularWidth: false, compactHeight: true) == .columns)
        #expect(BoardScreenRules.layout(regularWidth: true, compactHeight: true) == .columns)
        #expect(BoardScreenRules.layout(regularWidth: true, compactHeight: false) == .columns)
        #expect(BoardScreenRules.layout(regularWidth: false, compactHeight: false) == .pager)
    }
}
