import UIKit
import WebKit
import XCTest
@testable import Harness

/// The terminal's web view must never stay scrolled: WebKit scrolls a focused field above the keyboard
/// and the page pans itself instead.
@MainActor
final class TerminalWebViewTests: XCTestCase {
    func testLayoutPutsAScrolledWebViewBackAtTheOrigin() {
        let webView = TerminalWebView(frame: CGRect(x: 0, y: 0, width: 300, height: 400), configuration: WKWebViewConfiguration())
        var reported: [CGSize] = []
        webView.onLayout = { reported.append($0) }
        // UIKit leaves an offset alone only when there is content to scroll to.
        webView.scrollView.contentSize = CGSize(width: 300, height: 2000)
        webView.scrollView.contentOffset = CGPoint(x: 0, y: 120)
        XCTAssertEqual(webView.scrollView.contentOffset.y, 120)
        webView.setNeedsLayout()
        webView.layoutIfNeeded()
        XCTAssertEqual(webView.scrollView.contentOffset, .zero)
        XCTAssertEqual(reported.last, CGSize(width: 300, height: 400))
    }
}
