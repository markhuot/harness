import Testing
import HarnessKit

@Suite struct BoardChromeTests {
    @Test func theiPadAndALandscapePhoneDropTheTitleBar() {
        #expect(BoardScreenRules.hidesChrome(desktop: true, compactHeight: false))
        // A compact-width landscape phone and a Plus/Max one (regular width, compact height) alike.
        #expect(BoardScreenRules.hidesChrome(desktop: false, compactHeight: true))
        #expect(BoardScreenRules.hidesChrome(desktop: true, compactHeight: true))
    }

    @Test func thePortraitPhoneKeepsItsOwnBar() {
        #expect(!BoardScreenRules.hidesChrome(desktop: false, compactHeight: false))
    }

    @Test func theDuoUsesTheSystemBarInPortraitToo() {
        #expect(BoardScreenRules.hidesChrome(desktop: false, compactHeight: false, duo: true))
    }

    @Test func aLandscapePhoneShowsColumnsSideBySideLikeTheIPad() {
        #expect(BoardScreenRules.layout(regularWidth: false, compactHeight: true) == .columns)
        #expect(BoardScreenRules.layout(regularWidth: true, compactHeight: true) == .columns)
        #expect(BoardScreenRules.layout(regularWidth: true, compactHeight: false) == .columns)
        #expect(BoardScreenRules.layout(regularWidth: false, compactHeight: false) == .pager)
    }
}
