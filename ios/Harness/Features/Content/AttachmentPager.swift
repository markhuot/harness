import SwiftUI
import UIKit

/// The attachment viewer's pager: a horizontal paging UIScrollView, as RN's viewer is a paging
/// ScrollView. Each page hosts its SwiftUI page view, so a video page's AVPlayerViewController sits
/// inside the scroll view and the scroll view's pan sees every sideways swipe first. (A page-style
/// TabView lost swipes that started over the player's view, so the viewer often couldn't page off
/// a video.) `index` is the page to show; `onPage` reports the page a swipe settled on.
struct AttachmentPager: UIViewControllerRepresentable {
    let count: Int
    let index: Int
    /// Off while an image is zoomed or the viewer is closing.
    let scrollEnabled: Bool
    let page: (Int) -> AnyView
    let onPage: (Int) -> Void

    func makeUIViewController(context: Context) -> AttachmentPagerController {
        AttachmentPagerController(pages: (0..<count).map(page), start: index, onPage: onPage)
    }

    func updateUIViewController(_ vc: AttachmentPagerController, context: Context) {
        vc.onPage = onPage
        vc.update(pages: (0..<count).map(page))
        vc.setScrollEnabled(scrollEnabled)
        vc.show(index)
    }
}

final class AttachmentPagerController: UIViewController, UIScrollViewDelegate {
    private let scroll = UIScrollView()
    private var hosts: [UIHostingController<AnyView>]
    private(set) var current: Int
    var onPage: (Int) -> Void

    init(pages: [AnyView], start: Int, onPage: @escaping (Int) -> Void) {
        hosts = pages.map(Self.host)
        current = start
        self.onPage = onPage
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private static func host(_ page: AnyView) -> UIHostingController<AnyView> {
        let h = UIHostingController(rootView: page)
        h.view.backgroundColor = .clear
        // Pages place themselves with explicit insets (header above, home indicator below).
        h.safeAreaRegions = []
        return h
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        scroll.isPagingEnabled = true
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceVertical = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.scrollsToTop = false
        scroll.delegate = self
        view.addSubview(scroll)
        for h in hosts { attach(h) }
    }

    private func attach(_ h: UIHostingController<AnyView>) {
        addChild(h)
        scroll.addSubview(h.view)
        h.didMove(toParent: self)
    }

    /// New page content from SwiftUI (same count: a viewer's attachments don't change while open).
    func update(pages: [AnyView]) {
        guard pages.count == hosts.count else { return }
        for (h, p) in zip(hosts, pages) { h.rootView = p }
    }

    func setScrollEnabled(_ on: Bool) {
        if scroll.isScrollEnabled != on { scroll.isScrollEnabled = on }
    }

    /// Shows page `i` without animation unless a swipe is already taking it there.
    func show(_ i: Int) {
        guard hosts.indices.contains(i), i != current else { return }
        current = i
        guard !scroll.isDragging, !scroll.isDecelerating else { return }
        scroll.setContentOffset(CGPoint(x: CGFloat(i) * scroll.bounds.width, y: 0), animated: false)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = view.bounds.size
        scroll.frame = view.bounds
        for (i, h) in hosts.enumerated() {
            h.view.frame = CGRect(x: CGFloat(i) * size.width, y: 0, width: size.width, height: size.height)
        }
        scroll.contentSize = CGSize(width: size.width * CGFloat(hosts.count), height: size.height)
        // A new width (rotation, iPad split view) keeps the page that was showing.
        if !scroll.isDragging, !scroll.isDecelerating {
            scroll.contentOffset = CGPoint(x: CGFloat(current) * size.width, y: 0)
        }
    }

    private func settle() {
        let w = scroll.bounds.width
        guard w > 0 else { return }
        let i = min(max(Int((scroll.contentOffset.x / w).rounded()), 0), hosts.count - 1)
        guard i != current else { return }
        current = i
        onPage(i)
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { settle() }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { settle() }
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { settle() }
}
