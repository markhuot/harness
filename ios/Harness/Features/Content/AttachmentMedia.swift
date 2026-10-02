import AVFoundation
import HarnessKit
import SwiftUI
import UIKit

/// Loads attachment images and video posters once and keeps them while memory allows, so the
/// viewer opens on an image its thumbnail already fetched.
@MainActor
final class AttachmentMedia {
    static let shared = AttachmentMedia()

    enum LoadError: Error { case badURL, status(Int), undecodable }

    private let cache = NSCache<NSString, UIImage>()
    private var inflight: [String: Task<UIImage, Error>] = [:]

    /// An attachment's URL on the paired service (token in the query, so image and video views
    /// can load it). Nil without a store or a real client.
    static func url(_ store: BoardStore?, _ id: String) -> String? {
        store?.api?.attachmentUrl(id)
    }

    func cached(_ url: String, poster: Bool = false) -> UIImage? {
        cache.object(forKey: key(url, poster) as NSString)
    }

    /// The full image at `url` (decoded off the main thread).
    func image(_ url: String) async throws -> UIImage {
        try await load(url, poster: false) {
            guard let u = URL(string: url) else { throw LoadError.badURL }
            let (data, response) = try await URLSession.shared.data(from: u)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { throw LoadError.status(http.statusCode) }
            guard let image = await Self.decode(data) else { throw LoadError.undecodable }
            return image
        }
    }

    /// A video's first frame.
    func poster(_ url: String) async throws -> UIImage {
        try await load(url, poster: true) {
            guard let u = URL(string: url) else { throw LoadError.badURL }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: u))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 720, height: 720)
            let (frame, _) = try await generator.image(at: .zero)
            return UIImage(cgImage: frame)
        }
    }

    private func load(_ url: String, poster: Bool, _ make: @escaping @MainActor () async throws -> UIImage) async throws -> UIImage {
        let k = key(url, poster)
        if let hit = cache.object(forKey: k as NSString) { return hit }
        let task = inflight[k] ?? Task { try await make() }
        inflight[k] = task
        defer { inflight[k] = nil }
        let image = try await task.value
        cache.setObject(image, forKey: k as NSString)
        return image
    }

    private func key(_ url: String, _ poster: Bool) -> String { (poster ? "poster:" : "image:") + url }

    private nonisolated static func decode(_ data: Data) async -> UIImage? {
        await Task.detached(priority: .userInitiated) { UIImage(data: data)?.preparingForDisplay() }.value
    }
}

/// "Couldn't load" in a thumbnail, "Couldn't load <name>" on a viewer page.
struct AttachmentFailed: View {
    let name: String
    var compact = false
    var dark = false

    @Environment(\.palette) private var c

    var body: some View {
        let fg = dark ? Color.white.opacity(0.7) : c.text3
        VStack(spacing: 6) {
            Icon("alert", size: compact ? 18 : 28, weight: .regular)
            Text(compact ? "Couldn't load" : "Couldn't load \(name)")
                .font(.system(size: compact ? 11.5 : 14))
                .multilineTextAlignment(.center)
                .lineLimit(compact ? 2 : 3)
        }
        .foregroundStyle(fg)
        .padding(8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// What a viewer page reports to the viewer: how far it's pulled down, whether letting go closes
/// it, and whether it's zoomed (which stops paging).
struct AttachmentPageEvents {
    var onPull: @MainActor (CGFloat) -> Void
    var onRelease: @MainActor (Bool) -> Void
    var onZoom: @MainActor (Bool) -> Void = { _ in }
}

/// A full-screen viewer page: a UIScrollView that always bounces vertically, so pulling the page
/// down is the scroll view's own bounce (it works over images, video and the failed placeholder
/// alike and never fights horizontal paging), and that zooms an image 1–4× with pinch or a double
/// tap. Pull and release go through Attachments.pullOf/dismissOnRelease.
struct AttachmentPage: UIViewControllerRepresentable {
    enum Content {
        /// An image fitted in the page's box with Attachments.fitSize (`dims` from the attachment,
        /// else the decoded image); it zooms.
        case image(UIImage, dims: AttachmentDimensions)
        /// Any view controller filling the page (a video player, a hosted placeholder).
        case controller(UIViewController)
    }

    let content: Content
    /// The header above the page and the home indicator below: the page's box sits between them.
    let insets: UIEdgeInsets
    let events: AttachmentPageEvents

    func makeUIViewController(context: Context) -> AttachmentPageController {
        AttachmentPageController(content: content, insets: insets, events: events)
    }

    func updateUIViewController(_ vc: AttachmentPageController, context: Context) {
        vc.events = events
        vc.update(insets: insets)
    }
}

final class AttachmentPageController: UIViewController, UIScrollViewDelegate {
    private let scroll = UIScrollView()
    private let content: AttachmentPage.Content
    private var insets: UIEdgeInsets
    var events: AttachmentPageEvents
    private var zoomView: UIView?
    private var zoomed = false

    static let maxZoom: CGFloat = 4
    static let doubleTapZoom: CGFloat = 2.5

    init(content: AttachmentPage.Content, insets: UIEdgeInsets, events: AttachmentPageEvents) {
        self.content = content
        self.insets = insets
        self.events = events
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        scroll.delegate = self
        scroll.alwaysBounceVertical = true
        scroll.alwaysBounceHorizontal = false
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.decelerationRate = .fast
        view.addSubview(scroll)

        switch content {
        case let .image(image, _):
            let iv = UIImageView(image: image)
            iv.contentMode = .scaleAspectFit
            iv.isUserInteractionEnabled = true
            scroll.addSubview(iv)
            zoomView = iv
            scroll.minimumZoomScale = 1
            scroll.maximumZoomScale = Self.maxZoom
            scroll.bouncesZoom = true
            let tap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
            tap.numberOfTapsRequired = 2
            iv.addGestureRecognizer(tap)
        case let .controller(child):
            addChild(child)
            scroll.addSubview(child.view)
            child.didMove(toParent: self)
            scroll.minimumZoomScale = 1
            scroll.maximumZoomScale = 1
        }
    }

    func update(insets new: UIEdgeInsets) {
        guard new != insets else { return }
        insets = new
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scroll.frame = view.bounds
        let box = view.bounds.inset(by: insets)
        switch content {
        case let .image(_, dims):
            // A zoomed image keeps its frame (the zoom transform owns it).
            let fit = Attachments.fitSize(dims, in: AttachmentSize(width: Double(box.width), height: Double(box.height)))
            let fitted = CGSize(width: fit.width, height: fit.height)
            guard let iv = zoomView, scroll.zoomScale == 1, iv.frame.size != fitted else { break }
            iv.frame = CGRect(origin: .zero, size: fitted)
            scroll.contentSize = fitted
        case let .controller(child):
            child.view.frame = CGRect(origin: .zero, size: box.size)
            scroll.contentSize = box.size
        }
        center()
    }

    /// Keeps the content in the middle of the page's box (and the box below the header) at any zoom.
    private func center() {
        let box = view.bounds.inset(by: insets)
        let size = scroll.contentSize
        let dx = max(0, (box.width - size.width) / 2)
        let dy = max(0, (box.height - size.height) / 2)
        scroll.contentInset = UIEdgeInsets(top: insets.top + dy, left: insets.left + dx, bottom: insets.bottom + dy, right: insets.right + dx)
    }

    @objc private func doubleTapped(_ g: UITapGestureRecognizer) {
        // Toggle between fitted and 2.5× on the tapped point, like Photos.
        if scroll.zoomScale > 1.01 {
            scroll.setZoomScale(1, animated: true)
            return
        }
        guard let iv = zoomView else { return }
        let p = g.location(in: iv)
        let w = scroll.bounds.width / Self.doubleTapZoom
        let h = scroll.bounds.height / Self.doubleTapZoom
        scroll.zoom(to: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h), animated: true)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { zoomView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        center()
        let z = scrollView.zoomScale > 1.01
        if z != zoomed {
            zoomed = z
            events.onZoom(z)
        }
    }

    /// The offset past the page's resting place (negative while pulled down), as RN's contentOffset.y.
    private var restingOffsetY: CGFloat { scroll.contentOffset.y + scroll.adjustedContentInset.top }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        events.onPull(CGFloat(Attachments.pullOf(offsetY: Double(restingOffsetY), zoomScale: Double(scroll.zoomScale))))
    }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        // UIKit's velocity is points/ms, positive while the content moves up, as RN reports it.
        let close = Attachments.dismissOnRelease(offsetY: Double(restingOffsetY), velocityY: Double(velocity.y), zoomScale: Double(scroll.zoomScale))
        events.onRelease(close)
    }
}
